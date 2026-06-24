// Capa Tauri: comandos delgados que delegan toda la logica a context_core.
// Cada comando es invocado desde el frontend via window.__TAURI__.core.invoke(...)

use context_core::{AppConfig, GenerateResult, IndexEntry, TreeNode};
use std::collections::HashSet;
use std::path::PathBuf;

fn to_set(v: Vec<String>) -> HashSet<String> {
    v.into_iter().collect()
}

fn sorted_vec(s: HashSet<String>) -> Vec<String> {
    let mut v: Vec<String> = s.into_iter().collect();
    v.sort();
    v
}

// ─── Config ──────────────────────────────────────────────────────────────

#[tauri::command]
fn get_config() -> AppConfig {
    context_core::load_config()
}

#[tauri::command]
fn set_config(cfg: AppConfig) -> Result<(), String> {
    context_core::save_config(&cfg).map_err(|e| e.to_string())
}

#[tauri::command]
fn default_output_dir() -> String {
    context_core::output_dir().to_string_lossy().to_string()
}

// ─── Lista negra ─────────────────────────────────────────────────────────

#[tauri::command]
fn get_blacklist() -> Vec<String> {
    sorted_vec(context_core::load_blacklist())
}

#[tauri::command]
fn add_to_blacklist(path: String) -> Result<Vec<String>, String> {
    let mut bl = context_core::load_blacklist();
    bl.insert(path);
    context_core::save_blacklist(&bl).map_err(|e| e.to_string())?;
    Ok(sorted_vec(bl))
}

#[tauri::command]
fn remove_from_blacklist(paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut bl = context_core::load_blacklist();
    for p in paths {
        bl.remove(&p);
    }
    context_core::save_blacklist(&bl).map_err(|e| e.to_string())?;
    Ok(sorted_vec(bl))
}

#[tauri::command]
fn clear_blacklist() -> Result<Vec<String>, String> {
    let empty: HashSet<String> = HashSet::new();
    context_core::save_blacklist(&empty).map_err(|e| e.to_string())?;
    Ok(vec![])
}

// ─── Arbol / indice ──────────────────────────────────────────────────────

#[tauri::command]
fn get_tree(root: String, blacklist: Vec<String>) -> Result<TreeNode, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err(format!("La ruta no existe: {root}"));
    }
    if !root_path.is_dir() {
        return Err(format!("La ruta no es una carpeta: {root}"));
    }
    Ok(context_core::build_tree(&root_path, &to_set(blacklist)))
}

#[tauri::command]
fn get_index(root: String, blacklist: Vec<String>) -> Result<Vec<IndexEntry>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err(format!("La ruta no existe: {root}"));
    }
    Ok(context_core::index_all_files(&root_path, &to_set(blacklist)))
}

// ─── Generacion de contexto ──────────────────────────────────────────────

#[tauri::command]
fn generate_context(paths: Vec<String>, blacklist: Vec<String>) -> Result<GenerateResult, String> {
    if paths.is_empty() {
        return Err("No hay archivos ni carpetas seleccionadas".into());
    }
    let path_bufs: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    Ok(context_core::generate_content(&path_bufs, &to_set(blacklist)))
}

#[tauri::command]
fn save_output(dir: String, name: String, content: String) -> Result<String, String> {
    let out_dir = PathBuf::from(&dir);
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let file_name = if name.to_lowercase().ends_with(".txt") {
        name
    } else {
        format!("{name}.txt")
    };
    let full_path = out_dir.join(file_name);
    std::fs::write(&full_path, content).map_err(|e| e.to_string())?;
    Ok(full_path.to_string_lossy().to_string())
}

#[tauri::command]
fn bash_command(paths: Vec<String>, output_file: String) -> String {
    let path_bufs: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    context_core::generate_bash_command(&path_bufs, &PathBuf::from(output_file))
}

// ─── Entry point ─────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            default_output_dir,
            get_blacklist,
            add_to_blacklist,
            remove_from_blacklist,
            clear_blacklist,
            get_tree,
            get_index,
            generate_context,
            save_output,
            bash_command,
        ])
        .run(tauri::generate_context!())
        .expect("error al ejecutar la aplicacion Tauri");
}
