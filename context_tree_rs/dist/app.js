// app.js -- Context Tree (Tauri)
// Toda la logica de UI. El backend (Rust) solo expone comandos delgados;
// aqui replicamos el comportamiento de context_tree.py.

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
const dialogOpen = (opts) => window.__TAURI__.dialog.open(opts);
const clipboardWrite = (text) =>
  window.__TAURI__.clipboardManager.writeText(text);

function pickFolder(initial) {
  return dialogOpen({
    directory: true,
    multiple: false,
    defaultPath: initial || undefined,
    title: "Seleccionar carpeta",
  });
}

// ─── Estado global ─────────────────────────────────────────────────────

const state = {
  root: null,
  blacklist: [],
  treeRoot: null,
  nodeMap: new Map(), // path -> node
  rowEls: new Map(), // path -> elemento .tree-row
  childrenEls: new Map(), // path -> contenedor .tree-children
  checked: new Set(),
  expanded: new Set(),
  index: [],
  ctxPath: null,
  lastHighlighted: null,
};

const paletteState = { results: [], activeIndex: 0 };

// ─── Utilidades ────────────────────────────────────────────────────────

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

function fileIcon(name) {
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const map = {
    py: "py",
    ts: "ts",
    tsx: "tsx",
    jsx: "tsx",
    js: "js",
    json: "json",
    md: "md",
    txt: "txt",
    css: "css",
    html: "html",
    sql: "sql",
    sh: "sh",
  };
  return map[ext] || "txt";
}

function baseName(p) {
  return p.split(/[\\/]/).pop();
}

function dirName(p) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : ".";
}

function isUnder(path, dir) {
  return (
    path !== dir && (path.startsWith(dir + "/") || path.startsWith(dir + "\\"))
  );
}

function setStatus(msg) {
  document.getElementById("status-bar").textContent = msg;
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2500);
}

function showOverlay(id) {
  document.getElementById(id).classList.remove("hidden");
}
function hideOverlay(id) {
  document.getElementById(id).classList.add("hidden");
}

// ─── Arbol: construccion / render ─────────────────────────────────────

function indexNodes(node) {
  state.nodeMap.set(node.path, node);
  node.children.forEach(indexNodes);
}

function buildNodeDom(node, depth) {
  const wrapper = document.createElement("div");
  const row = document.createElement("div");
  row.className = "tree-row";
  row.dataset.path = node.path;
  row.style.paddingLeft = depth * 16 + 4 + "px";

  const hasChildren = node.is_dir && node.children.length > 0;
  const twirl = document.createElement("span");
  twirl.className = "tree-twirl" + (hasChildren ? "" : " empty");
  twirl.textContent = hasChildren
    ? state.expanded.has(node.path)
      ? "\u25be"
      : "\u25b8"
    : "";
  row.appendChild(twirl);

  const cb = document.createElement("span");
  cb.className = "tree-checkbox";
  cb.textContent = "[ ]";
  row.appendChild(cb);

  const icon = document.createElement("span");
  icon.className = "tree-icon";
  icon.textContent = node.is_dir ? "[+]" : `[${fileIcon(node.name)}]`;
  row.appendChild(icon);

  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = depth === 0 ? node.path : node.name;
  row.appendChild(name);

  wrapper.appendChild(row);
  state.rowEls.set(node.path, row);

  if (node.is_dir) {
    const childrenContainer = document.createElement("div");
    childrenContainer.className =
      "tree-children" + (state.expanded.has(node.path) ? "" : " collapsed");
    node.children.forEach((child) =>
      childrenContainer.appendChild(buildNodeDom(child, depth + 1)),
    );
    wrapper.appendChild(childrenContainer);
    state.childrenEls.set(node.path, childrenContainer);
  }
  return wrapper;
}

function renderTree() {
  state.rowEls.clear();
  state.childrenEls.clear();
  state.checked.clear();
  state.expanded.clear();
  state.lastHighlighted = null;
  if (state.treeRoot) state.expanded.add(state.treeRoot.path);

  const container = document.getElementById("tree-container");
  container.innerHTML = "";
  if (state.treeRoot) {
    container.appendChild(buildNodeDom(state.treeRoot, 0));
  }
  updateSelCount();
}

// ─── Seleccion (checkboxes) ────────────────────────────────────────────

function updateRowVisual(path) {
  const el = state.rowEls.get(path);
  if (!el) return;
  const checked = state.checked.has(path);
  el.classList.toggle("checked", checked);
  el.querySelector(".tree-checkbox").textContent = checked ? "[x]" : "[ ]";
}

function setCheckedRecursive(node, value) {
  if (value) state.checked.add(node.path);
  else state.checked.delete(node.path);
  updateRowVisual(node.path);
  node.children.forEach((c) => setCheckedRecursive(c, value));
}

function toggleCheck(path) {
  const node = state.nodeMap.get(path);
  if (!node) return;
  const newVal = !state.checked.has(path);
  setCheckedRecursive(node, newVal);
  updateSelCount();
}

function toggleExpand(path) {
  const node = state.nodeMap.get(path);
  if (!node || !node.is_dir || node.children.length === 0) return;
  const willExpand = !state.expanded.has(path);
  if (willExpand) state.expanded.add(path);
  else state.expanded.delete(path);
  const childrenEl = state.childrenEls.get(path);
  if (childrenEl) childrenEl.classList.toggle("collapsed", !willExpand);
  const twirl = state.rowEls.get(path)?.querySelector(".tree-twirl");
  if (twirl) twirl.textContent = willExpand ? "\u25be" : "\u25b8";
}

function getSelectedPaths() {
  const all = [...state.checked];
  return all.filter(
    (p) =>
      !all.some((other) => {
        if (other === p) return false;
        const otherNode = state.nodeMap.get(other);
        return otherNode && otherNode.is_dir && isUnder(p, other);
      }),
  );
}

function updateSelCount() {
  const n = getSelectedPaths().length;
  document.getElementById("sel-count").textContent =
    `${n} seleccionado${n !== 1 ? "s" : ""}`;
}

function clearSelection() {
  const prev = [...state.checked];
  state.checked.clear();
  prev.forEach(updateRowVisual);
  updateSelCount();
}

function removeFromNodeMapRecursive(node) {
  state.nodeMap.delete(node.path);
  node.children.forEach(removeFromNodeMapRecursive);
}

function removeNodeFromTree(path) {
  const row = state.rowEls.get(path);
  if (row && row.parentElement) row.parentElement.remove();
  state.rowEls.delete(path);
  state.childrenEls.delete(path);
  state.checked.delete(path);
  const node = state.nodeMap.get(path);
  if (node) removeFromNodeMapRecursive(node);
  updateSelCount();
}

// ─── Navegacion (resaltar item desde busqueda / palette) ──────────────

function highlightRow(path) {
  if (state.lastHighlighted) {
    const prevEl = state.rowEls.get(state.lastHighlighted);
    if (prevEl) prevEl.classList.remove("highlighted");
  }
  const el = state.rowEls.get(path);
  if (el) el.classList.add("highlighted");
  state.lastHighlighted = path;
}

function navigateTo(path) {
  if (!state.nodeMap.has(path)) {
    setStatus(
      `AVISO: ${baseName(path)} no encontrado -- en lista negra o recarga el arbol`,
    );
    return;
  }
  let p = path;
  while (true) {
    const parent = dirName(p);
    if (parent === p || !state.nodeMap.has(parent)) break;
    if (!state.expanded.has(parent)) toggleExpand(parent);
    p = parent;
    if (p === state.treeRoot.path) break;
  }
  const row = state.rowEls.get(path);
  if (row) {
    row.scrollIntoView({ block: "center" });
    highlightRow(path);
  }
  setStatus(`>> ${baseName(path)}   ->   ${dirName(path)}`);
}

// ─── Menu contextual (lista negra) ──────────────────────────────────────

function showContextMenu(x, y) {
  const menu = document.getElementById("context-menu");
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.classList.remove("hidden");
}

document.getElementById("context-menu").addEventListener("click", () => {});

document.addEventListener("click", (e) => {
  const menu = document.getElementById("context-menu");
  if (!menu.classList.contains("hidden") && !menu.contains(e.target)) {
    menu.classList.add("hidden");
  }
});

document
  .getElementById("ctx-add-blacklist")
  .addEventListener("click", async () => {
    const path = state.ctxPath;
    document.getElementById("context-menu").classList.add("hidden");
    if (!path) return;
    try {
      state.blacklist = await invoke("add_to_blacklist", { path });
      updateBlacklistButton();
      removeNodeFromTree(path);
      await rebuildIndex();
      setStatus(
        `[x] Bloqueado: ${state.blacklist.length} entradas en lista negra`,
      );
    } catch (err) {
      showToast("Error: " + err);
    }
  });

// ─── Eventos del arbol (click / right-click) ──────────────────────────

const treeContainer = document.getElementById("tree-container");

treeContainer.addEventListener("click", (e) => {
  const row = e.target.closest(".tree-row");
  if (!row) return;
  const path = row.dataset.path;
  const twirl = e.target.closest(".tree-twirl");
  if (twirl && !twirl.classList.contains("empty")) {
    toggleExpand(path);
  } else {
    toggleCheck(path);
  }
});

treeContainer.addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".tree-row");
  if (!row) return;
  e.preventDefault();
  state.ctxPath = row.dataset.path;
  showContextMenu(e.clientX, e.clientY);
});

// ─── Indice plano / busqueda rapida ────────────────────────────────────

function buildIndexFromTree(node, rootPath, out) {
  for (const child of node.children) {
    let rel = child.path;
    if (
      child.path.startsWith(rootPath + "/") ||
      child.path.startsWith(rootPath + "\\")
    ) {
      rel = child.path.slice(rootPath.length + 1);
    }
    out.push({ path: child.path, name: child.name, rel, is_dir: child.is_dir });
    if (child.is_dir) buildIndexFromTree(child, rootPath, out);
  }
  return out;
}

function rebuildIndex() {
  // El arbol ya tiene toda la informacion que necesita el indice de busqueda
  // (ruta, nombre, si es carpeta), asi que lo derivamos en JS en vez de
  // pedirle a Rust que vuelva a recorrer el disco entero por segunda vez.
  state.index = state.treeRoot
    ? buildIndexFromTree(state.treeRoot, state.treeRoot.path, [])
    : [];
  performSearch(document.getElementById("search-input").value.trim());
}

function filterIndex(query, limit) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  for (const it of state.index) {
    const relLower = it.rel.toLowerCase();
    if (terms.every((t) => relLower.includes(t))) {
      hits.push(it);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

function performSearch(q) {
  const resultsEl = document.getElementById("search-results");
  const countEl = document.getElementById("search-count");
  resultsEl.innerHTML = "";
  if (!q || q.length < 2) {
    resultsEl.innerHTML =
      '<div class="tree-empty-msg">Escribe para buscar...</div>';
    countEl.textContent = "";
    return;
  }
  const hits = filterIndex(q, 50);
  if (!hits.length) {
    resultsEl.innerHTML = `<div class="tree-empty-msg">Sin resultados para "${escapeHtml(q)}"</div>`;
    countEl.textContent = "";
    return;
  }
  countEl.textContent = `${hits.length} resultado${hits.length !== 1 ? "s" : ""}`;
  for (const it of hits) {
    const row = document.createElement("div");
    row.className = "result-row";
    row.dataset.path = it.path;
    const main = document.createElement("div");
    main.className = "result-main" + (it.is_dir ? " dir-result" : "");
    main.textContent = `${it.is_dir ? "[+]" : "[" + fileIcon(it.name) + "]"}  ${it.name}`;
    const sub = document.createElement("div");
    sub.className = "result-sub";
    sub.textContent = `[${dirName(it.rel) === "." ? "" : dirName(it.rel)}]`;
    row.appendChild(main);
    row.appendChild(sub);
    resultsEl.appendChild(row);
  }
}

document.getElementById("search-results").addEventListener("click", (e) => {
  const row = e.target.closest(".result-row");
  if (row) navigateTo(row.dataset.path);
});

let searchDebounce = null;
document.getElementById("search-input").addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  const val = e.target.value.trim();
  searchDebounce = setTimeout(() => performSearch(val), 160);
});
document.getElementById("search-clear").addEventListener("click", () => {
  document.getElementById("search-input").value = "";
  performSearch("");
});

// ─── Command palette (Ctrl+P) ───────────────────────────────────────────

function openPalette() {
  if (!state.index.length) {
    setStatus("Indexando...");
    return;
  }
  paletteState.results = [];
  paletteState.activeIndex = 0;
  document.getElementById("palette-input").value = "";
  document.getElementById("palette-results").innerHTML = "";
  document.getElementById("palette-footer").textContent =
    "Escribe para buscar...";
  showOverlay("command-palette");
  document.getElementById("palette-input").focus();
}

function closePalette() {
  hideOverlay("command-palette");
}

function paletteFilter() {
  const q = document.getElementById("palette-input").value.trim();
  const resultsEl = document.getElementById("palette-results");
  resultsEl.innerHTML = "";
  if (!q) {
    paletteState.results = [];
    document.getElementById("palette-footer").textContent =
      "Escribe para buscar...";
    return;
  }
  const hits = filterIndex(q, 40);
  paletteState.results = hits;
  paletteState.activeIndex = 0;
  if (!hits.length) {
    resultsEl.innerHTML = `<div class="palette-row muted">Sin resultados para "${escapeHtml(q)}"</div>`;
    document.getElementById("palette-footer").textContent = "0 resultados";
    return;
  }
  hits.forEach((it, i) => {
    const row = document.createElement("div");
    row.className =
      "palette-row" +
      (it.is_dir ? " dir-result" : "") +
      (i === 0 ? " active" : "");
    const parent = dirName(it.rel) === "." ? "" : dirName(it.rel);
    row.textContent = `${it.is_dir ? "[+]" : "[" + fileIcon(it.name) + "]"}  ${it.name.padEnd(36)}  ${parent}`;
    row.dataset.index = String(i);
    resultsEl.appendChild(row);
  });
  document.getElementById("palette-footer").textContent =
    `${hits.length} resultado(s)`;
}

function setPaletteActive(i) {
  const rows = document.querySelectorAll("#palette-results .palette-row");
  rows.forEach((r) => r.classList.remove("active"));
  if (rows[i]) {
    rows[i].classList.add("active");
    rows[i].scrollIntoView({ block: "nearest" });
  }
  paletteState.activeIndex = i;
}

function selectPaletteActive() {
  const item = paletteState.results[paletteState.activeIndex];
  if (!item) return;
  closePalette();
  navigateTo(item.path);
}

document
  .getElementById("palette-input")
  .addEventListener("input", paletteFilter);
document.getElementById("palette-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    setPaletteActive(
      Math.min(paletteState.activeIndex + 1, paletteState.results.length - 1),
    );
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    setPaletteActive(Math.max(paletteState.activeIndex - 1, 0));
  } else if (e.key === "Enter") {
    e.preventDefault();
    selectPaletteActive();
  }
});
document.getElementById("palette-results").addEventListener("click", (e) => {
  const row = e.target.closest(".palette-row");
  if (row && row.dataset.index !== undefined) {
    paletteState.activeIndex = Number(row.dataset.index);
    selectPaletteActive();
  }
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "p" || e.key === "P")) {
    e.preventDefault();
    openPalette();
  } else if (e.key === "Escape") {
    if (
      !document.getElementById("command-palette").classList.contains("hidden")
    ) {
      closePalette();
      return;
    }
    document
      .querySelectorAll(".overlay:not(.hidden)")
      .forEach((ov) => ov.classList.add("hidden"));
  }
});

document.querySelectorAll(".overlay").forEach((ov) => {
  ov.addEventListener("click", (e) => {
    if (e.target === ov) ov.classList.add("hidden");
  });
});

// ─── Carga de arbol / cambio de raiz ────────────────────────────────────

async function loadRoot(path) {
  setStatus("Cargando...");
  try {
    const tree = await invoke("get_tree", {
      root: path,
      blacklist: state.blacklist,
    });
    state.root = path;
    state.treeRoot = tree;
    state.nodeMap.clear();
    indexNodes(tree);
    renderTree();
    document.getElementById("root-input").value = path;
    await rebuildIndex();
    setStatus(`Arbol cargado: ${path}`);
    return true;
  } catch (err) {
    setStatus("ERROR: " + err);
    return false;
  }
}

document
  .getElementById("btn-browse-root")
  .addEventListener("click", async () => {
    const current = document.getElementById("root-input").value;
    const chosen = await pickFolder(current);
    if (chosen) await loadRoot(chosen);
  });
document.getElementById("btn-load").addEventListener("click", () => {
  loadRoot(document.getElementById("root-input").value.trim());
});
document.getElementById("root-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadRoot(e.target.value.trim());
});
document
  .getElementById("btn-clear-selection")
  .addEventListener("click", clearSelection);

// ─── Lista negra: boton + modal ─────────────────────────────────────────

function updateBlacklistButton() {
  const n = state.blacklist.length;
  document.getElementById("btn-blacklist").textContent =
    n > 0 ? `Lista negra (${n})` : "Lista negra";
}

async function refreshBlacklistModal() {
  const list = document.getElementById("blacklist-list");
  list.innerHTML = "";
  const bl = [...state.blacklist].sort();
  if (!bl.length) {
    list.innerHTML =
      '<div class="tree-empty-msg">Lista negra vacia -- no hay nada bloqueado</div>';
  } else {
    for (const p of bl) {
      const row = document.createElement("label");
      row.className = "bl-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.path = p;
      row.appendChild(cb);
      const span = document.createElement("span");
      span.textContent = `  [x] ${baseName(p)}  \u2014  ${p}`;
      row.appendChild(span);
      list.appendChild(row);
    }
  }
  document.getElementById("bl-count").textContent =
    `${bl.length} entrada${bl.length !== 1 ? "s" : ""} bloqueada${bl.length !== 1 ? "s" : ""}`;
}

document.getElementById("btn-blacklist").addEventListener("click", async () => {
  await refreshBlacklistModal();
  showOverlay("overlay-blacklist");
});

document.getElementById("btn-bl-remove").addEventListener("click", async () => {
  const checked = [
    ...document.querySelectorAll(
      '#blacklist-list input[type="checkbox"]:checked',
    ),
  ].map((cb) => cb.dataset.path);
  if (!checked.length) return;
  state.blacklist = await invoke("remove_from_blacklist", { paths: checked });
  await refreshBlacklistModal();
  updateBlacklistButton();
  if (state.root) await loadRoot(state.root);
  setStatus(`Lista negra: ${state.blacklist.length} entradas`);
});

document.getElementById("btn-bl-clear").addEventListener("click", async () => {
  if (!state.blacklist.length) return;
  if (!confirm("Limpiar toda la lista negra?")) return;
  state.blacklist = await invoke("clear_blacklist");
  await refreshBlacklistModal();
  updateBlacklistButton();
  if (state.root) await loadRoot(state.root);
});

document
  .getElementById("btn-bl-close")
  .addEventListener("click", () => hideOverlay("overlay-blacklist"));

// ─── Configuracion (ruta predeterminada) ────────────────────────────────

document.getElementById("btn-config").addEventListener("click", async () => {
  const cfg = await invoke("get_config");
  document.getElementById("cfg-current").textContent = cfg.default_root
    ? `Actual: ${cfg.default_root}`
    : "Actual: (ninguna)";
  showOverlay("overlay-config");
});

document
  .getElementById("btn-cfg-use-current")
  .addEventListener("click", async () => {
    if (!state.root) return;
    await invoke("set_config", { cfg: { default_root: state.root } });
    document.getElementById("cfg-current").textContent =
      `Actual: ${state.root}`;
    setStatus("Ruta predeterminada guardada");
  });

document
  .getElementById("btn-cfg-browse")
  .addEventListener("click", async () => {
    const chosen = await pickFolder(state.root);
    if (!chosen) return;
    await invoke("set_config", { cfg: { default_root: chosen } });
    document.getElementById("cfg-current").textContent = `Actual: ${chosen}`;
    await loadRoot(chosen);
    setStatus("Ruta predeterminada guardada");
  });

document.getElementById("btn-cfg-clear").addEventListener("click", async () => {
  await invoke("set_config", { cfg: { default_root: null } });
  document.getElementById("cfg-current").textContent = "Actual: (ninguna)";
  setStatus("Ruta predeterminada eliminada -- te preguntara al iniciar");
});

document
  .getElementById("btn-cfg-close")
  .addEventListener("click", () => hideOverlay("overlay-config"));

// ─── Generar / Copiar / Bash ─────────────────────────────────────────────

function showPreview(result) {
  const preview = document.getElementById("preview");
  let pv = result.content.slice(0, 10000);
  if (result.content.length > 10000) {
    pv += "\n\n[... preview truncado -- archivo completo guardado ...]";
  }
  preview.value = pv;
  document.getElementById("token-info").textContent =
    `~${result.tokens_estimate.toLocaleString()} tokens  .  ${result.files.length} archivos  .  ` +
    `${result.lines.toLocaleString()} lineas  .  ${(result.bytes / 1024).toFixed(1)} KB`;
}

function requireSelection() {
  const paths = getSelectedPaths();
  if (!paths.length) {
    showToast("Selecciona al menos un archivo o carpeta.");
    return null;
  }
  return paths;
}

document.getElementById("btn-generate").addEventListener("click", async () => {
  const paths = requireSelection();
  if (!paths) return;
  const btn = document.getElementById("btn-generate");
  btn.disabled = true;
  setStatus("Generando...");
  try {
    const result = await invoke("generate_context", {
      paths,
      blacklist: state.blacklist,
    });
    const name = document.getElementById("out-name").value.trim() || "contexto";
    const dir = document.getElementById("out-dir").value.trim();
    const fullPath = await invoke("save_output", {
      dir,
      name,
      content: result.content,
    });
    showPreview(result);
    setStatus(`Guardado: ${fullPath}`);
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    document.getElementById("out-name").value = `contexto_${hh}${mm}`;
  } catch (err) {
    setStatus("ERROR: " + err);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btn-copy").addEventListener("click", async () => {
  const paths = requireSelection();
  if (!paths) return;
  setStatus("Copiando...");
  try {
    const result = await invoke("generate_context", {
      paths,
      blacklist: state.blacklist,
    });
    await clipboardWrite(result.content);
    setStatus(
      `Copiado: ${result.files.length} archivos . ~${result.tokens_estimate.toLocaleString()} tokens . ${(result.bytes / 1024).toFixed(1)} KB`,
    );
  } catch (err) {
    setStatus("ERROR: " + err);
  }
});

document.getElementById("btn-bash").addEventListener("click", async () => {
  const paths = requireSelection();
  if (!paths) return;
  const name = document.getElementById("out-name").value.trim() || "contexto";
  const dir = document
    .getElementById("out-dir")
    .value.trim()
    .replace(/[/\\]+$/, "");
  const fileName = name.toLowerCase().endsWith(".txt") ? name : `${name}.txt`;
  const outputFile = `${dir}/${fileName}`;
  try {
    const cmd = await invoke("bash_command", { paths, outputFile });
    document.getElementById("bash-output").value = cmd;
    showOverlay("overlay-bash");
  } catch (err) {
    setStatus("ERROR: " + err);
  }
});

document.getElementById("btn-bash-copy").addEventListener("click", async () => {
  await clipboardWrite(document.getElementById("bash-output").value);
  const btn = document.getElementById("btn-bash-copy");
  const original = btn.textContent;
  btn.textContent = "Copiado!";
  setTimeout(() => {
    btn.textContent = original;
  }, 1500);
});
document
  .getElementById("btn-bash-close")
  .addEventListener("click", () => hideOverlay("overlay-bash"));

document
  .getElementById("btn-browse-outdir")
  .addEventListener("click", async () => {
    const current = document.getElementById("out-dir").value;
    const chosen = await pickFolder(current);
    if (chosen) {
      document.getElementById("out-dir").value = chosen;
      setStatus(`Directorio de salida: ${chosen}`);
    }
  });

// ─── Inicio ───────────────────────────────────────────────────────────

async function init() {
  try {
    document.getElementById("out-dir").value =
      await invoke("default_output_dir");
  } catch (e) {
    /* ignore */
  }

  try {
    state.blacklist = await invoke("get_blacklist");
  } catch (e) {
    state.blacklist = [];
  }
  updateBlacklistButton();

  let cfg = {};
  try {
    cfg = await invoke("get_config");
  } catch (e) {
    /* ignore */
  }

  let ok = false;
  if (cfg.default_root) {
    ok = await loadRoot(cfg.default_root);
  }
  if (!ok) {
    const chosen = await pickFolder();
    if (chosen) {
      ok = await loadRoot(chosen);
    } else {
      setStatus('Selecciona una carpeta de proyecto con el boton "..."');
    }
  }
  performSearch("");
}

init();
