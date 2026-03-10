use std::process::Command;

fn main() {
    // Get git commit hash of this playground repo
    let pg_commit = git_short_hash().unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=PLAYGROUND_COMMIT={}", pg_commit);

    // Get almide dependency version + commit from cargo metadata
    let (almide_ver, almide_commit) = get_almide_info();
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

fn get_almide_info() -> (String, String) {
    let unknown = ("unknown".to_string(), "unknown".to_string());
    let output = match Command::new("cargo")
        .args(["metadata", "--format-version=1"])
        .output()
    {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return unknown,
    };

    // Find almide package id: "almide 0.x.y (git+https://...#commithash)"
    let mut version = "unknown".to_string();
    let mut commit = "unknown".to_string();

    for segment in output.split("\"id\":\"") {
        let seg = segment.trim_start();
        if seg.starts_with("almide ") && !seg.starts_with("almide-playground") {
            // Extract version: "almide 0.4.1 (...)"
            let parts: Vec<&str> = seg.splitn(3, ' ').collect();
            if parts.len() >= 2 {
                version = parts[1].to_string();
            }
            // Extract commit hash after #
            if let Some(hash_pos) = seg.find('#') {
                let rest = &seg[hash_pos + 1..];
                if let Some(end) = rest.find('"') {
                    let full = &rest[..end];
                    commit = full[..7.min(full.len())].to_string();
                }
            }
            break;
        }
    }
    (version, commit)
}
