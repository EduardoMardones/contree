# Context Tree (Rust + Tauri)

Port de `context_tree.py` (Python/customtkinter) a Rust + Tauri 2, manteniendo
la misma estetica oscura y el mismo flujo de trabajo: arbol de proyecto con
checkboxes, lista negra (click derecho), busqueda rapida, command palette
(Ctrl+P) y generacion de contexto para IA (.txt / portapapeles / comando bash).

## Estructura del proyecto

```
context_tree_rs/
├── context_core/         # Logica pura (sin UI), 100% testeada con `cargo test`
│   └── src/lib.rs         # ignorados, lista negra, arbol, generar contexto, bash
├── src-tauri/             # App Tauri (comandos delgados que llaman a context_core)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/default.json   # permisos (dialog + clipboard)
│   ├── icons/              # <- aqui van los iconos generados (ver mas abajo)
│   └── src/main.rs
└── dist/                   # Frontend estatico (sin build step: HTML/CSS/JS vanilla)
    ├── index.html
    ├── style.css
    └── app.js
```

La logica de archivos (que ignorar, lista negra, generar el .txt, generar el
comando bash) vive en `context_core` y tiene **9 tests automatizados** que ya
verifique en este entorno (`cargo test` dentro de `context_core/` -> 9/9 OK).
`src-tauri` es solo la capa de comandos que expone esa logica al frontend.

## 1. Prerequisitos (importante)

**Usa `rustup`, no el `rustc`/`cargo` de `apt`.** Lo confirme en el proceso de
armar esto: el `cargo` de los repos de Ubuntu 24.04 trae Rust 1.75, y Tauri 2
ya necesita `edition2024` (Cargo >= 1.85). Instala Rust con:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustc --version   # deberia ser 1.85 o superior
```

Dependencias de sistema para compilar la parte GTK/WebKit en Linux (Debian/Ubuntu):

```bash
sudo apt update
sudo apt install -y build-essential pkg-config \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev file
```

Instala el CLI de Tauri (una sola vez):

```bash
cargo install tauri-cli --version "^2.0.0" --locked
```

## 2. Generar el icono de la app

Tu logo `contree-logo.png` no estaba en los archivos que me compartiste, asi
que no pude generarlo yo. Cópialo dentro de `src-tauri/` y genera el set
completo de iconos (Tauri crea todas las resoluciones + .ico/.icns automaticamente):

```bash
cd src-tauri
cargo tauri icon contree-logo.png
```

Esto llena la carpeta `icons/` que ya esta referenciada en `tauri.conf.json`.
Si te lo saltas, `cargo tauri dev` funciona igual (el icono solo es obligatorio
para `cargo tauri build`).

## 3. Probar la logica pura (sin GUI)

```bash
cd context_core
cargo test
```

Deberias ver `test result: ok. 9 passed`.

## 4. Modo desarrollo (ventana en vivo)

Desde la raiz del proyecto (`context_tree_rs/`):

```bash
cargo tauri dev
```

Como el frontend es HTML/CSS/JS estatico (sin React/Vite/npm), no hay paso de
build: Tauri sirve directamente lo que hay en `dist/`. Si editas `app.js` o
`style.css`, basta con recargar la ventana (no hace falta recompilar Rust,
salvo que cambies algo en `src-tauri/` o `context_core/`).

## 5. Empaquetar como AppImage

```bash
cargo tauri build
```

El `.AppImage` queda en:

```
src-tauri/target/release/bundle/appimage/context-tree_0.1.0_amd64.AppImage
```

(`cargo tauri build` tambien genera un `.deb` porque lo deje configurado en
`tauri.conf.json` bajo `bundle.targets`; si solo quieres AppImage, cambia esa
lista a `["appimage"]`).

## 6. Compatibilidad con la version Python

A proposito, la config y la lista negra usan el **mismo formato JSON y la
misma carpeta** (`~/textos_intranet/.config.json` y `.blacklist.json`) que la
version en Python. Si vienes migrando, tu lista negra existente ya va a
funcionar tal cual con esta version en Rust.

## 7. Diferencias respecto a la version Python (decisiones de diseno)

- **Selector de carpetas**: en vez de tu `FolderPicker` custom (con accesos
  rapidos, barra de ruta navegable, etc.), uso el dialogo nativo del sistema
  operativo (vía `tauri-plugin-dialog`). Es mas simple de mantener y se ve
  "nativo" en cualquier escritorio Linux. Si preferis el selector custom tipo
  el de Python, se puede agregar despues como un modal HTML adicional.
- **Arbol completo en memoria**: igual que el Python, se carga el arbol
  entero al abrir el proyecto (no carga perezosa por carpeta). Para proyectos
  gigantes (cientos de miles de archivos) convendria pasar a carga perezosa
  por directorio; para proyectos de tamano normal no deberia notarse, y
  ademas en Rust el escaneo es mucho mas rapido que en Python.

## 8. Si algo no compila

Pegame el error de `cargo tauri build` / `cargo tauri dev` y lo resolvemos.
La parte mas propensa a necesitar un ajuste menor es `src-tauri/src/main.rs`
(las firmas exactas de los plugins de Tauri cambian de vez en cuando entre
versiones 2.x), ya que no pude compilar esa capa completa en este entorno
(rustc viejo de apt, ver seccion 1) — si verifiqué cada nombre de API contra
la documentacion oficial de Tauri, pero un `cargo check` real en tu maquina
es la prueba definitiva.
