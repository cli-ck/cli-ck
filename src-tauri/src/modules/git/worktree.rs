use std::path::Path;
#[cfg(target_os = "macos")]
use std::process::Command;

use crate::modules::git::errors::{GitError, Result};
use crate::modules::git::operations;
use crate::modules::git::process::{ensure_git_available, ensure_success, run_git};
use crate::modules::git::types::{AgentWorktreeResult, DEFAULT_TIMEOUT_SECS};
use crate::modules::git::utils::authorized_repo_root;
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

/// Directories copied into a freshly-provisioned agent worktree so the agent
/// doesn't need a cold `npm install`/`cargo build` before it can run.
const WARM_START_DIRS: [&str; 2] = ["node_modules", "src-tauri/target"];

/// Provisions a new git worktree for an AI agent to work in, branched off
/// `origin/main`, and best-effort warm-starts it by copying build caches
/// from the source repo. Reuses the existing `pty_open` command from the
/// frontend to actually launch an agent CLI in the returned path — this
/// function only prepares the directory.
pub fn create(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    branch: &str,
    workspace: &WorkspaceEnv,
) -> Result<AgentWorktreeResult> {
    if !is_safe_branch_name(branch) {
        return Err(GitError::InvalidPath(branch.to_string()));
    }
    let resolved = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&resolved.workspace)?;

    operations::fetch(registry, repo_root, workspace)?;

    let slug = branch
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(branch);
    let repo_path = Path::new(&resolved.git_path);
    let worktree_dir = repo_path.join(".worktree");
    std::fs::create_dir_all(&worktree_dir)?;
    let target = worktree_dir.join(slug);
    if target.exists() {
        return Err(GitError::command(
            "worktree path already exists",
            target.display().to_string(),
        ));
    }

    let output = run_git(
        &resolved.workspace,
        Some(&resolved.git_path),
        [
            "worktree",
            "add",
            target.to_string_lossy().as_ref(),
            "-b",
            branch,
            "origin/main",
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git worktree add failed")?;

    for rel in WARM_START_DIRS {
        // Best-effort: a warm-start copy failure shouldn't fail provisioning,
        // the worktree is already fully usable without it (just slower to
        // first build).
        let _ = fast_copy_if_present(repo_path, &target, rel);
    }

    Ok(AgentWorktreeResult {
        worktree_path: target.display().to_string(),
        branch: branch.to_string(),
    })
}

/// Mirrors `is_safe_pathspec`'s defense-in-depth style (reject control
/// chars, `:`, `..`) but for a git ref/branch name rather than a pathspec.
pub fn is_safe_branch_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 200 {
        return false;
    }
    if name.contains("..") || name.contains(':') || name.contains('\\') || name.contains("//") {
        return false;
    }
    if name.starts_with('/')
        || name.starts_with('-')
        || name.ends_with('/')
        || name.ends_with(".lock")
    {
        return false;
    }
    if name.chars().any(|c| c.is_whitespace() || (c as u32) < 0x20) {
        return false;
    }
    !name.split('/').any(|seg| seg.is_empty())
}

fn fast_copy_if_present(repo_root: &Path, target_root: &Path, rel: &str) -> Result<()> {
    let src = repo_root.join(rel);
    if !src.exists() {
        return Ok(());
    }
    let dst = target_root.join(rel);
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    #[cfg(target_os = "macos")]
    if apfs_clonefile_copy(&src, &dst) {
        return Ok(());
    }
    copy_tree_portable(&src, &dst)
}

/// Fast path: `cp -c` uses `clonefile(2)` on APFS, a copy-on-write clone
/// that doesn't actually duplicate disk space. Returns false on any failure
/// (non-APFS volume, `cp` missing, etc.) so the caller falls back.
#[cfg(target_os = "macos")]
fn apfs_clonefile_copy(src: &Path, dst: &Path) -> bool {
    Command::new("cp")
        .arg("-c")
        .arg("-R")
        .arg(src)
        .arg(dst)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

// ponytail: manual recursive copy, symlinks preserved on unix only. Good
// enough as a best-effort provisioning speedup on Linux/Windows; upgrade if
// non-macOS worktree provisioning speed ever actually matters.
fn copy_tree_portable(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if file_type.is_symlink() {
            #[cfg(unix)]
            {
                let link_target = std::fs::read_link(entry.path())?;
                let _ = std::os::unix::fs::symlink(link_target, &dst_path);
            }
        } else if file_type.is_dir() {
            copy_tree_portable(&entry.path(), &dst_path)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    #[test]
    fn safe_branch_name_accepts_normal_names() {
        assert!(is_safe_branch_name("feat/agent-worktree"));
        assert!(is_safe_branch_name("fix/bug-123"));
    }

    #[test]
    fn safe_branch_name_rejects_traversal_and_control_chars() {
        assert!(!is_safe_branch_name(""));
        assert!(!is_safe_branch_name("../escape"));
        assert!(!is_safe_branch_name("feat/../escape"));
        assert!(!is_safe_branch_name("evil:branch"));
        assert!(!is_safe_branch_name("has space"));
        assert!(!is_safe_branch_name("has\ttab"));
        assert!(!is_safe_branch_name("-flag-like"));
        assert!(!is_safe_branch_name("trailing/"));
        assert!(!is_safe_branch_name("a//b"));
        assert!(!is_safe_branch_name("refs.lock"));
    }

    fn init_repo(dir: &Path) {
        let run = |args: &[&str]| {
            let status = StdCommand::new("git")
                .args(args)
                .current_dir(dir)
                .status()
                .expect("run git");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);
    }

    #[test]
    fn creates_a_real_worktree_from_a_temp_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        init_repo(&origin);

        let clone = tmp.path().join("clone");
        let status = StdCommand::new("git")
            .args(["clone", "-q"])
            .arg(&origin)
            .arg(&clone)
            .status()
            .expect("clone");
        assert!(status.success());

        let registry = WorkspaceRegistry::default();
        let repo_root_str = clone.to_string_lossy().to_string();
        let _ = registry.authorize(&clone);

        let result = create(
            &registry,
            &repo_root_str,
            "feat/agent-test",
            &WorkspaceEnv::Local,
        )
        .expect("worktree created");

        assert!(result.worktree_path.ends_with("agent-test"));
        assert!(Path::new(&result.worktree_path).join("README.md").exists());

        let status = StdCommand::new("git")
            .args(["rev-parse", "--is-inside-work-tree"])
            .current_dir(&result.worktree_path)
            .status()
            .expect("check worktree");
        assert!(status.success());
    }

    #[test]
    fn fast_copy_falls_back_to_portable_copy_and_preserves_content() {
        let tmp = tempfile::tempdir().unwrap();
        let src_root = tmp.path().join("src_repo");
        let modules_dir = src_root.join("node_modules").join("pkg");
        std::fs::create_dir_all(&modules_dir).unwrap();
        std::fs::write(modules_dir.join("index.js"), b"module.exports = 1;\n").unwrap();

        let dst_root = tmp.path().join("dst_repo");
        std::fs::create_dir_all(&dst_root).unwrap();

        fast_copy_if_present(&src_root, &dst_root, "node_modules").expect("copy ok");

        let copied = dst_root.join("node_modules").join("pkg").join("index.js");
        assert_eq!(
            std::fs::read(copied).unwrap(),
            b"module.exports = 1;\n".to_vec()
        );
    }

    #[test]
    fn fast_copy_is_a_noop_when_source_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let src_root = tmp.path().join("src_repo");
        std::fs::create_dir_all(&src_root).unwrap();
        let dst_root = tmp.path().join("dst_repo");
        std::fs::create_dir_all(&dst_root).unwrap();

        fast_copy_if_present(&src_root, &dst_root, "node_modules").expect("noop ok");
        assert!(!dst_root.join("node_modules").exists());
    }
}
