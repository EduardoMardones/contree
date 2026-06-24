//! context_core
//!
//! Logica pura (sin UI) portada desde context_tree.py:
//! - listas de ignorados (extensiones / carpetas)
//! - lista negra persistida en JSON
//! - configuracion persistida en JSON (ruta predeterminada)
//! - construccion de arbol de archivos respetando ignorados + lista negra
//! - indexado plano para busqueda / command palette
//! - generacion del contexto (.txt) a partir de archivos/carpetas seleccionados
//! - generacion del comando bash equivalente

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

// ─── Constantes (mismas que el Python) ──────────────────────────────────

pub const IGNORE_EXTENSIONS: &[&str] = &[
    "pyc", "zip", "png", "jpg", "jpeg", "svg", "ico", "woff", "woff2", "ttf",
    "map", "lock",
];

pub const IGNORE_DIRS: &[&str] = &[
    "node_modules",
    "__pycache__",
    ".git",
    "env",
    "dist",
    "migrations",
    ".next",
    "build",
    ".venv",
    "media",
];

// ─── Config / Blacklist persistidas ─────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct AppConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_root: Option<String>,
}

/// Carpeta donde se guardan `.config.json` y `.blacklist.json`,
/// igual que `Path.home() / "textos_intranet"` en el Python.
pub fn output_dir() -> PathBuf {
    let base = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("Resumen_Contree");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn config_file() -> PathBuf {
    output_dir().join(".config.json")
}

fn blacklist_file() -> PathBuf {
    output_dir().join(".blacklist.json")
}

pub fn load_config() -> AppConfig {
    fs::read_to_string(config_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_config(cfg: &AppConfig) -> std::io::Result<()> {
    let data = serde_json::to_string_pretty(cfg).unwrap_or_default();
    fs::write(config_file(), data)
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct BlacklistFile {
    #[serde(default)]
    paths: Vec<String>,
}

pub fn load_blacklist() -> HashSet<String> {
    fs::read_to_string(blacklist_file())
        .ok()
        .and_then(|s| serde_json::from_str::<BlacklistFile>(&s).ok())
        .map(|b| b.paths.into_iter().collect())
        .unwrap_or_default()
}

pub fn save_blacklist(bl: &HashSet<String>) -> std::io::Result<()> {
    let mut paths: Vec<String> = bl.iter().cloned().collect();
    paths.sort();
    let data = serde_json::to_string_pretty(&BlacklistFile { paths }).unwrap_or_default();
    fs::write(blacklist_file(), data)
}

// ─── Utilidades ──────────────────────────────────────────────────────────

pub fn should_ignore(name: &str, is_dir: bool) -> bool {
    if is_dir {
        return IGNORE_DIRS.contains(&name) || name.starts_with('.');
    }
    if name.starts_with('.') {
        return true;
    }
    match Path::new(name).extension().and_then(|e| e.to_str()) {
        Some(ext) => IGNORE_EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(ext)),
        None => false,
    }
}

/// Una ruta esta bloqueada si coincide exactamente con una entrada de la
/// lista negra, o si esta anidada dentro de una carpeta bloqueada.
pub fn is_blacklisted(path: &str, blacklist: &HashSet<String>) -> bool {
    if blacklist.contains(path) {
        return true;
    }
    let sep = std::path::MAIN_SEPARATOR;
    blacklist
        .iter()
        .any(|bl| path.starts_with(&format!("{bl}{sep}")))
}

fn sorted_children(path: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = match fs::read_dir(path) {
        Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
        Err(_) => return vec![],
    };
    // Igual que Python: carpetas primero, despues archivos, ambos alfabeticos.
    entries.sort_by(|a, b| {
        let a_is_file = a.is_file();
        let b_is_file = b.is_file();
        a_is_file
            .cmp(&b_is_file)
            .then_with(|| {
                a.file_name()
                    .map(|n| n.to_string_lossy().to_lowercase())
                    .cmp(&b.file_name().map(|n| n.to_string_lossy().to_lowercase()))
            })
    });
    entries
}

// ─── Arbol de archivos (para el panel "Proyecto") ───────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct TreeNode {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub children: Vec<TreeNode>,
}

/// Construye el arbol completo desde `root`, omitiendo lo ignorado y lo
/// bloqueado. `root` se incluye siempre aunque este en la lista negra
/// (no tendria sentido cargar un proyecto bloqueado).
pub fn build_tree(root: &Path, blacklist: &HashSet<String>) -> TreeNode {
    let root_str = root.to_string_lossy().to_string();
    TreeNode {
        path: root_str.clone(),
        name: root_str,
        is_dir: true,
        children: build_children(root, blacklist),
    }
}

fn build_children(dir: &Path, blacklist: &HashSet<String>) -> Vec<TreeNode> {
    let mut out = Vec::new();
    for child in sorted_children(dir) {
        let name = child
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let is_dir = child.is_dir();
        if should_ignore(&name, is_dir) {
            continue;
        }
        let path_str = child.to_string_lossy().to_string();
        if is_blacklisted(&path_str, blacklist) {
            continue;
        }
        let children = if is_dir {
            build_children(&child, blacklist)
        } else {
            Vec::new()
        };
        out.push(TreeNode {
            path: path_str,
            name,
            is_dir,
            children,
        });
    }
    out
}

// ─── Indice plano (busqueda rapida / command palette) ───────────────────

#[derive(Debug, Serialize, Clone)]
pub struct IndexEntry {
    pub path: String,
    pub name: String,
    pub rel: String,
    pub is_dir: bool,
}

pub fn index_all_files(root: &Path, blacklist: &HashSet<String>) -> Vec<IndexEntry> {
    let mut out = Vec::new();
    index_walk(root, root, blacklist, &mut out);
    out
}

fn index_walk(root: &Path, dir: &Path, blacklist: &HashSet<String>, out: &mut Vec<IndexEntry>) {
    for child in sorted_children(dir) {
        let name = child
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let is_dir = child.is_dir();
        if should_ignore(&name, is_dir) {
            continue;
        }
        let path_str = child.to_string_lossy().to_string();
        if is_blacklisted(&path_str, blacklist) {
            continue;
        }
        let rel = child
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| path_str.clone());
        out.push(IndexEntry {
            path: path_str,
            name,
            rel,
            is_dir,
        });
        if is_dir {
            index_walk(root, &child, blacklist, out);
        }
    }
}

// ─── Generacion de contexto ──────────────────────────────────────────────

/// Recolecta todos los archivos bajo `path` (o el archivo mismo),
/// respetando ignorados y lista negra.
pub fn collect_files(path: &Path, blacklist: &HashSet<String>) -> Vec<PathBuf> {
    if path.is_file() {
        let path_str = path.to_string_lossy().to_string();
        return if is_blacklisted(&path_str, blacklist) {
            vec![]
        } else {
            vec![path.to_path_buf()]
        };
    }
    let mut files = Vec::new();
    collect_walk(path, blacklist, &mut files);
    files
}

fn collect_walk(dir: &Path, blacklist: &HashSet<String>, out: &mut Vec<PathBuf>) {
    for child in sorted_children(dir) {
        let name = child
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let is_dir = child.is_dir();
        if should_ignore(&name, is_dir) {
            continue;
        }
        let path_str = child.to_string_lossy().to_string();
        if is_blacklisted(&path_str, blacklist) {
            continue;
        }
        if is_dir {
            collect_walk(&child, blacklist, out);
        } else {
            out.push(child);
        }
    }
}

#[derive(Debug, Serialize)]
pub struct GenerateResult {
    pub content: String,
    pub files: Vec<String>,
    pub lines: usize,
    pub bytes: usize,
    pub tokens_estimate: usize,
}

/// Equivalente a `generate_content` del Python: junta el contenido de
/// todos los archivos seleccionados (deduplicados) con el separador
/// "==>> ARCHIVO: ...".
pub fn generate_content(paths: &[PathBuf], blacklist: &HashSet<String>) -> GenerateResult {
    let mut all_files = Vec::new();
    for p in paths {
        all_files.extend(collect_files(p, blacklist));
    }
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for f in all_files {
        let resolved = fs::canonicalize(&f).unwrap_or_else(|_| f.clone());
        if seen.insert(resolved) {
            unique.push(f);
        }
    }

    let mut parts = Vec::new();
    for f in &unique {
        let header = format!("==>> ARCHIVO: {}\n{}", f.display(), "─".repeat(60));
        match fs::read_to_string(f) {
            Ok(content) => parts.push(format!("{header}\n{content}\n")),
            Err(e) => parts.push(format!("{header}\n[ERROR: {e}]\n")),
        }
    }
    let content = parts.join("\n");
    let lines = content.lines().count();
    let bytes = content.as_bytes().len();
    let tokens_estimate = content.chars().count() / 4;
    GenerateResult {
        content,
        files: unique.iter().map(|p| p.to_string_lossy().to_string()).collect(),
        lines,
        bytes,
        tokens_estimate,
    }
}

/// Equivalente a `generate_bash_command` del Python.
pub fn generate_bash_command(paths: &[PathBuf], output_file: &Path) -> String {
    if paths.is_empty() {
        return String::new();
    }
    let of = output_file.display();
    let mut cmds = Vec::new();
    for (i, p) in paths.iter().enumerate() {
        let op = if i == 0 { ">" } else { ">>" };
        if p.is_file() {
            cmds.push(format!(
                "echo \"==>> ARCHIVO: {}\" {op} \"{of}\" && cat \"{}\" >> \"{of}\"",
                p.display(),
                p.display()
            ));
        } else {
            cmds.push(format!(
                "find \"{}\" -type f | sort | while read f; do\n  echo \"==>> ARCHIVO: $f\" >> \"{of}\"\n  cat \"$f\" >> \"{of}\"\ndone",
                p.display()
            ));
        }
    }
    cmds.join(" && \\\n\n")
}

pub fn file_icon(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .as_deref()
    {
        Some("py") => "py",
        Some("ts") => "ts",
        Some("tsx") | Some("jsx") => "tsx",
        Some("js") => "js",
        Some("json") => "json",
        Some("md") => "md",
        Some("css") => "css",
        Some("html") => "html",
        Some("sql") => "sql",
        Some("sh") => "sh",
        _ => "txt",
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Crea un directorio temporal unico bajo el tmp del sistema.
    fn temp_project() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("context_core_test_{}_{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ignores_known_dirs_and_dotfiles() {
        assert!(should_ignore("node_modules", true));
        assert!(should_ignore(".git", true));
        assert!(should_ignore(".env", false));
        assert!(!should_ignore("src", true));
    }

    #[test]
    fn ignores_known_extensions_case_insensitive() {
        assert!(should_ignore("logo.PNG", false));
        assert!(should_ignore("bundle.lock", false));
        assert!(!should_ignore("main.rs", false));
    }

    #[test]
    fn blacklist_exact_and_nested() {
        let mut bl = HashSet::new();
        bl.insert("/proj/secret".to_string());
        assert!(is_blacklisted("/proj/secret", &bl));
        assert!(is_blacklisted("/proj/secret/inner.txt", &bl));
        assert!(!is_blacklisted("/proj/secret_other", &bl)); // no debe matchear por prefijo de string suelto
        assert!(!is_blacklisted("/proj/public", &bl));
    }

    #[test]
    fn build_tree_skips_ignored_and_blacklisted() {
        let root = temp_project();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main(){}").unwrap();
        fs::write(root.join("secret.txt"), "shh").unwrap();
        fs::write(root.join("logo.png"), "binary").unwrap();

        let mut bl = HashSet::new();
        bl.insert(root.join("secret.txt").to_string_lossy().to_string());

        let tree = build_tree(&root, &bl);
        let names: Vec<&str> = tree.children.iter().map(|c| c.name.as_str()).collect();

        assert!(!names.contains(&"node_modules")); // ignorado
        assert!(!names.contains(&"secret.txt"));   // lista negra
        assert!(!names.contains(&"logo.png"));     // extension ignorada
        assert!(names.contains(&"src"));

        let src_node = tree.children.iter().find(|c| c.name == "src").unwrap();
        assert_eq!(src_node.children.len(), 1);
        assert_eq!(src_node.children[0].name, "main.rs");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn generate_content_concatenates_and_dedupes() {
        let root = temp_project();
        fs::create_dir_all(root.join("pkg")).unwrap();
        fs::write(root.join("pkg/a.txt"), "Hola").unwrap();
        fs::write(root.join("pkg/b.txt"), "Mundo").unwrap();

        let bl = HashSet::new();
        // Pasamos la carpeta y tambien el archivo a.txt -> debe deduplicarse.
        let paths = vec![root.join("pkg"), root.join("pkg/a.txt")];
        let result = generate_content(&paths, &bl);

        assert_eq!(result.files.len(), 2);
        assert!(result.content.contains("ARCHIVO:"));
        assert!(result.content.contains("Hola"));
        assert!(result.content.contains("Mundo"));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn generate_content_respects_blacklist() {
        let root = temp_project();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("public.txt"), "visible").unwrap();
        fs::write(root.join("private.txt"), "oculto").unwrap();

        let mut bl = HashSet::new();
        bl.insert(root.join("private.txt").to_string_lossy().to_string());

        let result = generate_content(&[root.clone()], &bl);
        assert!(result.content.contains("visible"));
        assert!(!result.content.contains("oculto"));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn bash_command_for_single_file() {
        let root = temp_project();
        let f = root.join("real.txt");
        fs::write(&f, "contenido").unwrap();
        let out = PathBuf::from("/tmp/out.txt");
        let cmd = generate_bash_command(&[f], &out);
        assert!(cmd.starts_with("echo \"==>> ARCHIVO:"));
        assert!(cmd.contains("\"/tmp/out.txt\""));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn bash_command_for_directory_uses_find() {
        let root = temp_project();
        let out = PathBuf::from("/tmp/out.txt");
        let cmd = generate_bash_command(&[root.clone()], &out);
        assert!(cmd.contains("find \""));
        assert!(cmd.contains("-type f"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn index_all_files_builds_relative_paths() {
        let root = temp_project();
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("a/b/c.rs"), "fn x(){}").unwrap();

        let bl = HashSet::new();
        let idx = index_all_files(&root, &bl);
        let entry = idx.iter().find(|e| e.name == "c.rs").unwrap();
        assert_eq!(entry.rel, Path::new("a/b/c.rs").to_string_lossy());

        fs::remove_dir_all(&root).unwrap();
    }
}
