use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::io::Read as _;
use std::io::Write as _;
use std::path::Path;

pub const DEFAULT_MACHINE_CODE_FILE: &str = "/tmp/codex-remote-mcp-machine-code";

const MACHINE_CODE_PREFIX: &str = "rmc_";
const MACHINE_CODE_RANDOM_BYTES: usize = 16;
const RANDOM_SOURCE: &str = "/dev/urandom";

pub fn load_or_create_machine_code(path: &Path) -> io::Result<String> {
    match fs::read_to_string(path) {
        Ok(contents) => return parse_machine_code(&contents, path),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(with_path("read remote MCP machine code", path, err)),
    }

    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)
            .map_err(|err| with_path("create remote MCP machine-code directory", parent, err))?;
    }

    let machine_code = generate_machine_code()?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid machine-code path"))?;
    let temporary_path = path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        &machine_code[MACHINE_CODE_PREFIX.len()..]
    ));

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut temporary_file = options.open(&temporary_path).map_err(|err| {
        with_path(
            "create temporary remote MCP machine-code file",
            &temporary_path,
            err,
        )
    })?;
    let write_result = (|| -> io::Result<()> {
        temporary_file.write_all(machine_code.as_bytes())?;
        temporary_file.write_all(b"\n")?;
        temporary_file.sync_all()
    })();
    if let Err(err) = write_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(with_path(
            "persist remote MCP machine code",
            &temporary_path,
            err,
        ));
    }
    drop(temporary_file);

    let link_result = fs::hard_link(&temporary_path, path);
    let _ = fs::remove_file(&temporary_path);
    match link_result {
        Ok(()) => Ok(machine_code),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            let contents = fs::read_to_string(path).map_err(|read_err| {
                with_path("read concurrently created machine code", path, read_err)
            })?;
            parse_machine_code(&contents, path)
        }
        Err(err) => Err(with_path("install remote MCP machine code", path, err)),
    }
}

fn parse_machine_code(contents: &str, path: &Path) -> io::Result<String> {
    let machine_code = contents.trim();
    if machine_code.len() != MACHINE_CODE_PREFIX.len() + MACHINE_CODE_RANDOM_BYTES * 2
        || !machine_code.starts_with(MACHINE_CODE_PREFIX)
        || !machine_code[MACHINE_CODE_PREFIX.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "invalid remote MCP machine code in {}; refusing to replace stable identity",
                path.display()
            ),
        ));
    }
    Ok(machine_code.to_string())
}

fn generate_machine_code() -> io::Result<String> {
    const HEX: &[u8; 16] = b"0123456789abcdef";

    let mut random = [0_u8; MACHINE_CODE_RANDOM_BYTES];
    File::open(RANDOM_SOURCE)?.read_exact(&mut random)?;
    let mut machine_code = String::with_capacity(MACHINE_CODE_PREFIX.len() + random.len() * 2);
    machine_code.push_str(MACHINE_CODE_PREFIX);
    for byte in random {
        machine_code.push(HEX[(byte >> 4) as usize] as char);
        machine_code.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(machine_code)
}

fn with_path(action: &str, path: &Path, err: io::Error) -> io::Error {
    io::Error::new(
        err.kind(),
        format!("failed to {action} at {}: {err}", path.display()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn create() -> io::Result<Self> {
            let machine_code = generate_machine_code()?;
            let path = std::env::temp_dir().join(format!(
                "codex-remote-machine-code-test-{}-{machine_code}",
                std::process::id()
            ));
            fs::create_dir(&path)?;
            Ok(Self(path))
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn machine_code_persists_until_identity_file_is_removed() -> io::Result<()> {
        let directory = TestDirectory::create()?;
        let identity_file = directory.0.join("machine-code");

        let first = load_or_create_machine_code(&identity_file)?;
        let restarted = load_or_create_machine_code(&identity_file)?;
        assert_eq!(restarted, first);

        fs::remove_file(&identity_file)?;
        let replacement_instance = load_or_create_machine_code(&identity_file)?;
        assert_ne!(replacement_instance, first);
        assert!(replacement_instance.starts_with(MACHINE_CODE_PREFIX));
        assert_eq!(replacement_instance.len(), 36);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn newly_created_machine_code_file_is_owner_only() -> io::Result<()> {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::create()?;
        let identity_file = directory.0.join("machine-code");
        load_or_create_machine_code(&identity_file)?;

        let mode = fs::metadata(identity_file)?.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        Ok(())
    }

    #[test]
    fn invalid_existing_machine_code_is_not_silently_replaced() -> io::Result<()> {
        let directory = TestDirectory::create()?;
        let identity_file = directory.0.join("machine-code");
        fs::write(&identity_file, "container-name-or-hostname\n")?;

        let error = match load_or_create_machine_code(&identity_file) {
            Ok(machine_code) => {
                return Err(io::Error::other(format!(
                    "invalid stable identity was replaced with {machine_code}"
                )));
            }
            Err(error) => error,
        };
        assert!(
            error
                .to_string()
                .contains("refusing to replace stable identity")
        );
        assert_eq!(
            fs::read_to_string(identity_file)?,
            "container-name-or-hostname\n"
        );
        Ok(())
    }
}
