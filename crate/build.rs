use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=Cargo.lock");

    // Get git commit hash of this playground repo
    let pg_commit = git_short_hash().unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=PLAYGROUND_COMMIT={}", pg_commit);

    // Get almide dependency version + commit from Cargo.lock
    let (almide_ver, almide_commit) = parse_lockfile();
    println!("cargo:rustc-env=ALMIDE_VERSION={}", almide_ver);
    println!("cargo:rustc-env=ALMIDE_COMMIT={}", almide_commit);
}

fn git_short_hash() -> Option<String> {
    let o = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()?;
    if o.status.success() {
        Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
    } else {
        None
    }
}

fn parse_lockfile() -> (String, String) {
    let lock = match std::fs::read_to_string("Cargo.lock") {
        Ok(s) => s,
        Err(_) => return ("unknown".to_string(), "unknown".to_string()),
    };

    // Cargo.lock format:
    // [[package]]
    // name = "almide"
    // version = "0.1.0"
    // source = "git+https://...#87f3971c2d76..."
    let mut version = "unknown".to_string();
    let mut commit = "unknown".to_string();
    let mut found_almide = false;

    for line in lock.lines() {
        let trimmed = line.trim();
        if trimmed == "[[package]]" {
            found_almide = false;
        } else if trimmed == r#"name = "almide""# {
            found_almide = true;
        } else if found_almide {
            if let Some(ver) = trimmed.strip_prefix("version = \"") {
                version = ver.trim_end_matches('"').to_string();
            }
            if let Some(src) = trimmed.strip_prefix("source = \"") {
                // source = "git+https://...#commithash"
                if let Some(hash_pos) = src.find('#') {
                    let full = src[hash_pos + 1..].trim_end_matches('"');
                    commit = full[..7.min(full.len())].to_string();
                }
                break; // Got everything we need
            }
        }
    }
    (version, commit)
}
