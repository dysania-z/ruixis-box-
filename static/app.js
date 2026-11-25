const COLORS = [
  "#7f1d1d", "#9a3412", "#92400e", "#a16207", "#3f6212", "#14532d", "#134e4a", "#155e75", "#1e3a8a", "#312e81", "#4c1d95", "#831843",
  "#b60205", "#d93f0b", "#b45309", "#ca8a04", "#4d7c0f", "#0e8a16", "#0f7b6c", "#0891b2", "#1d76db", "#4338ca", "#5319e7", "#ad1a72",
  "#e03e3e", "#f97316", "#d97706", "#fbca04", "#65a30d", "#22c55e", "#0d9488", "#06b6d4", "#3b82f6", "#6366f1", "#7c3aed", "#db2777",
  "#f4c7c3", "#f9d0c4", "#fde68a", "#fef2c0", "#d9f99d", "#c2e0c6", "#bfdadc", "#cffafe", "#c5def5", "#c7d2fe", "#d4c5f9", "#fbcfe8",
];
const SOURCE_LABEL = {
  cursor: "Cursor",
  codex: "Codex",
  chatgpt: "ChatGPT",
  deepseek: "DeepSeek",
  other: "其他",
};

const state = {
  q: "",
  tagId: null,
  tags: [],
  conversations: [],
  total: 0,
  activeId: null,
  detail: null,
  editingTag: null,
  editing: false,
  color: COLORS[0],
};

const $ = (id) => document.getElementById(id);

function tagChipStyle(color) {
  const hex = String(color || "#6b4a2a").replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const text = luminance > 0.62 ? "#1c1712" : "#fffdf8";
  return `background:${color};color:${text};border-color:transparent`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function highlight(value) {
  let html = escapeHtml(value);
  const terms = state.q.trim().split(/\s+/).filter((term) => term.length > 0);
  for (const term of terms) {
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    html = html.replace(pattern, (match) => `<mark>${match}</mark>`);
  }
  return html;
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

async function uploadImage(payload) {
  const result = await api("/api/images", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return result.url;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读不了这张图"));
    reader.readAsDataURL(file);
  });
}

async function uploadFile(file) {
  const dataUrl = await readFileAsDataUrl(file);
  const comma = dataUrl.indexOf(",");
  const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return uploadImage({ mime: file.type, data });
}

function clipboardImageFiles(data) {
  const files = [];
  if (!data) return files;
  for (const item of data.items || []) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length) return files;
  return [...(data.files || [])].filter((file) => file.type.startsWith("image/"));
}

async function localizeMarkdownImages(text) {
  const pattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const matches = [...String(text).matchAll(pattern)];
  let out = text;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i];
    const alt = match[1];
    const src = match[2].trim();
    if (src.startsWith("/media/")) continue;
    if (!(src.startsWith("data:") || src.startsWith("http://") || src.startsWith("https://"))) continue;
    try {
      const url = src.startsWith("data:")
        ? await uploadImage({ data: src })
        : await uploadImage({ url: src });
      const start = match.index;
      out = `${out.slice(0, start)}![${alt}](${url})${out.slice(start + match[0].length)}`;
    } catch {
      /* keep original src */
    }
  }
  return out;
}

function insertInTextarea(box, text) {
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? box.value.length;
  box.value = `${box.value.slice(0, start)}${text}${box.value.slice(end)}`;
  const pos = start + text.length;
  box.selectionStart = box.selectionEnd = pos;
  box.focus();
}

let editRange = null;

function rememberEditSelection() {
  const body = $("answer-body");
  const sel = window.getSelection();
  if (!body || !sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (body === range.commonAncestorContainer || body.contains(range.commonAncestorContainer)) {
    editRange = range.cloneRange();
  }
}

function restoreEditSelection() {
  const body = $("answer-body");
  if (!body) return;
  body.focus();
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  if (editRange) sel.addRange(editRange);
}

function insertImageNode(url, alt = "") {
  restoreEditSelection();
  const body = $("answer-body");
  if (!body) return;
  const img = document.createElement("img");
  img.className = "md-img";
  img.src = url;
  img.alt = alt;
  const sel = window.getSelection();
  if (sel && sel.rangeCount && (body === sel.anchorNode || body.contains(sel.anchorNode))) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(img);
    range.setStartAfter(img);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    editRange = range.cloneRange();
  } else {
    body.appendChild(img);
  }
}

async function loadLibrary() {
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.tagId) params.set("tag", state.tagId);
  const data = await api(`/api/library?${params.toString()}`);
  state.tags = data.tags;
  state.conversations = data.conversations;
  state.total = data.total;
  render();
}

function render() {
  $("total-count").textContent = state.total;
  $("all-btn").classList.toggle("active", !state.tagId);
  const current = state.tags.find((tag) => String(tag.id) === String(state.tagId));
  $("list-title").textContent = current ? current.name : "全部收藏";
  $("list-kicker").textContent = current ? "标签" : state.q ? "搜索结果" : "匣子";
  $("list-count").textContent = state.conversations.length;
  $("search-hint").textContent = current
    ? `正在「${current.name}」里查找`
    : "正在全部收藏里查找";

  $("tag-list").innerHTML = state.tags
    .map(
      (tag) => `
      <li>
        <div class="tag-item ${String(tag.id) === String(state.tagId) ? "active" : ""}">
          <button type="button" data-tag="${tag.id}">
            <span><i class="dot" style="background:${tag.color}"></i>${escapeHtml(tag.name)}</span>
          </button>
          <em>${tag.count}</em>
          <span class="tag-actions">
            <button type="button" data-edit="${tag.id}">改</button>
            <button type="button" data-del="${tag.id}">删</button>
          </span>
        </div>
      </li>`
    )
    .join("");

  $("cards").innerHTML = state.conversations.length
    ? state.conversations
        .map(
          (item) => `
        <button class="card ${item.id === state.activeId ? "active" : ""}" type="button" data-id="${item.id}">
          <div class="card-top">
            <h3>${highlight(item.title)}</h3>
          </div>
          <p>${highlight(item.preview || "")}</p>
          <div class="meta">
            <span class="source ${item.source}">${SOURCE_LABEL[item.source] || item.source}</span>
            ${item.tags
              .map(
                (tag) =>
                  `<span class="mini-tag" style="${tagChipStyle(tag.color)}">${escapeHtml(tag.name)}</span>`
              )
              .join("")}
            <span class="time">${formatTime(item.updated_at || item.created_at)}</span>
          </div>
        </button>`
        )
        .join("")
    : `<div class="empty"><h3>这里还是空的</h3><p>${
        state.q || state.tagId ? "换个关键词，或去掉标签筛选。" : "点左下角「收藏这条回答」，把喜欢的那一次回复贴进来。"
      }</p></div>`;

  renderReader();
}

function renderReader() {
  const reader = $("reader");
  const detail = state.detail;
  if (!detail) {
    reader.classList.remove("open");
    reader.innerHTML = `
      <div class="empty-reader">
        <p class="eyebrow">阅读</p>
        <h2>收藏一条回答。</h2>
        <p>在 Cursor、Codex、ChatGPT 或 DeepSeek 里复制你喜欢的那一次回答，贴进来。代码、列表和标题会按原样显示。之后搜索关键词，就能找到当时的那段话。</p>
      </div>`;
    return;
  }
  reader.classList.add("open");
  const selected = new Set(detail.tags.map((tag) => tag.id));
  reader.innerHTML = `
    <header class="reader-head">
      <div>
        <p class="eyebrow">${SOURCE_LABEL[detail.source] || detail.source}</p>
        <h2>${escapeHtml(detail.title)}</h2>
        <div class="tag-row">
          ${detail.tags
            .map(
              (tag) =>
                `<button class="chip" style="background:${tag.color}" data-untag="${tag.id}" type="button">${escapeHtml(tag.name)} ×</button>`
            )
            .join("")}
          <select class="add-tag" id="add-tag">
            <option value="">＋ 打标签</option>
            ${state.tags
              .filter((tag) => !selected.has(tag.id))
              .map((tag) => `<option value="${tag.id}">${escapeHtml(tag.name)}</option>`)
              .join("")}
          </select>
        </div>
      </div>
      <div class="reader-tools">
        <button type="button" id="edit-clip">改回答</button>
        <button type="button" id="rename">改标题</button>
        <button type="button" id="remove" class="danger">移出匣子</button>
        <button type="button" id="back-list" class="ghost">返回</button>
      </div>
    </header>
    <div class="thread" id="thread"></div>`;
  const question = detail.messages.find((message) => message.role === "user")?.content || "";
  const answer = detail.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.content)
    .join("\n\n");
  $("thread").innerHTML = `
    ${question ? `<blockquote class="ask"><span class="who">问题</span>${renderMarkdown(question)}</blockquote>` : ""}
    <article class="sheet">
      <span class="who">回答</span>
      <div class="md answer-body" id="answer-body">${renderMarkdown(answer)}</div>
      <div class="row edit-actions" id="edit-actions">
        <button type="button" class="solid" id="save-edit">保存修改</button>
        <button type="button" id="insert-edit-image">插入图片</button>
        <button type="button" id="cancel-edit">取消</button>
      </div>
      <p class="status" id="edit-status"></p>
    </article>`;
  if (state.editing) beginVisualEdit();
  else markTerms($("answer-body"));
  paintMermaid($("thread"));
}

function beginVisualEdit() {
  state.editing = true;
  const body = $("answer-body");
  if (!body) return;
  body.contentEditable = "true";
  body.classList.add("editing");
  $("edit-actions").classList.add("show");
  body.focus();
}

function markTerms(root) {
  const terms = state.q.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return;
  const pattern = new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement?.closest(".mermaid-wrap, svg, .katex, .math-block, .math-inline")) continue;
    if (!pattern.test(node.textContent)) continue;
    pattern.lastIndex = 0;
    const span = document.createElement("span");
    span.innerHTML = escapeHtml(node.textContent).replace(pattern, (match) => `<mark>${match}</mark>`);
    node.replaceWith(span);
  }
}

async function openConversation(id) {
  state.activeId = id;
  state.editing = false;
  state.detail = await api(`/api/conversations/${id}`);
  render();
}

async function setTags(tagIds) {
  await api(`/api/conversations/${state.activeId}/tags`, {
    method: "PUT",
    body: JSON.stringify({ tagIds }),
  });
  await openConversation(state.activeId);
  await loadLibrary();
}

function openTagDialog(tag) {
  state.editingTag = tag;
  state.color = tag?.color || COLORS[state.tags.length % COLORS.length];
  $("tag-dialog-title").textContent = tag ? "修改标签" : "新建标签";
  $("tag-name").value = tag?.name || "";
  $("swatches").innerHTML = COLORS.map(
    (color) =>
      `<button type="button" class="swatch ${color === state.color ? "on" : ""}" data-color="${color}" style="background:${color}"></button>`
  ).join("");
  $("tag-dialog").showModal();
  $("tag-name").focus();
}

let timer = 0;
$("search").addEventListener("input", (event) => {
  state.q = event.target.value;
  clearTimeout(timer);
  timer = setTimeout(() => loadLibrary().catch(alert), 180);
});

$("all-btn").addEventListener("click", () => {
  state.tagId = null;
  loadLibrary().catch(alert);
});

$("tag-list").addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-edit]");
  const del = event.target.closest("[data-del]");
  const pick = event.target.closest("[data-tag]");
  if (edit) {
    const tag = state.tags.find((item) => String(item.id) === edit.dataset.edit);
    openTagDialog(tag);
    return;
  }
  if (del) {
    const tag = state.tags.find((item) => String(item.id) === del.dataset.del);
    if (!tag || !confirm(`删除标签「${tag.name}」？对话本身会留下。`)) return;
    await api(`/api/tags/${tag.id}`, { method: "DELETE" });
    if (String(state.tagId) === String(tag.id)) state.tagId = null;
    await loadLibrary();
    return;
  }
  if (pick) {
    state.tagId = pick.dataset.tag;
    loadLibrary().catch(alert);
  }
});

$("cards").addEventListener("click", (event) => {
  const card = event.target.closest("[data-id]");
  if (card) openConversation(card.dataset.id).catch(alert);
});

$("reader").addEventListener("click", async (event) => {
  if (event.target.id === "back-list") {
    $("reader").classList.remove("open");
    return;
  }
  if (event.target.id === "edit-clip" && state.detail && !state.editing) {
    beginVisualEdit();
    return;
  }
  if (event.target.id === "insert-edit-image" && state.editing) {
    rememberEditSelection();
    $("edit-image-file").click();
    return;
  }
  if (event.target.id === "cancel-edit") {
    state.editing = false;
    renderReader();
    return;
  }
  if (event.target.id === "save-edit" && state.detail) {
    const status = $("edit-status");
    try {
      status.textContent = "正在保存…";
      const question = state.detail.messages.find((message) => message.role === "user")?.content || "";
      const previous = state.detail.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content)
        .join("\n\n");
      const answer = htmlToMarkdown($("answer-body").innerHTML);
      if (previous.trim().length > 80 && answer.trim().length < previous.trim().length * 0.4) {
        status.textContent = "这次保存会丢掉很多原文，已取消。请再看一眼回答再存。";
        return;
      }
      await api(`/api/conversations/${state.detail.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          question,
          answer,
        }),
      });
      state.editing = false;
      await openConversation(state.detail.id);
      await loadLibrary();
    } catch (error) {
      status.textContent = error.message;
    }
    return;
  }
  if (event.target.id === "rename" && state.detail) {
    const title = prompt("新标题", state.detail.title);
    if (!title || !title.trim()) return;
    await api(`/api/conversations/${state.detail.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: title.trim() }),
    });
    await openConversation(state.detail.id);
    await loadLibrary();
    return;
  }
  if (event.target.id === "remove" && state.detail) {
    if (!confirm("从匣子里移出这条对话？")) return;
    await api(`/api/conversations/${state.detail.id}`, { method: "DELETE" });
    state.activeId = null;
    state.detail = null;
    await loadLibrary();
    return;
  }
  const untag = event.target.closest("[data-untag]");
  if (untag && state.detail) {
    const next = state.detail.tags
      .map((tag) => tag.id)
      .filter((id) => String(id) !== untag.dataset.untag);
    await setTags(next);
  }
});

$("reader").addEventListener("change", async (event) => {
  if (event.target.id !== "add-tag" || !event.target.value || !state.detail) return;
  const next = [...state.detail.tags.map((tag) => tag.id), Number(event.target.value)];
  await setTags(next);
});

$("reader").addEventListener("paste", async (event) => {
  if (!state.editing) return;
  const body = $("answer-body");
  if (!body || !(body === event.target || body.contains(event.target))) return;
  const files = clipboardImageFiles(event.clipboardData);
  if (files.length) {
    event.preventDefault();
    for (const file of files) {
      try {
        insertImageNode(await uploadFile(file));
      } catch (error) {
        $("edit-status").textContent = error.message;
      }
    }
    return;
  }
  const html = event.clipboardData?.getData("text/html") || "";
  if (!html || !/<img/i.test(html)) return;
  event.preventDefault();
  try {
    const localized = await localizeMarkdownImages(htmlToMarkdown(html));
    restoreEditSelection();
    document.execCommand("insertHTML", false, renderMarkdown(localized) || localized);
    paintMermaid(body);
  } catch (error) {
    $("edit-status").textContent = error.message;
  }
});

$("new-tag").addEventListener("click", () => openTagDialog(null));
$("cancel-tag").addEventListener("click", () => $("tag-dialog").close());
$("swatches").addEventListener("click", (event) => {
  const swatch = event.target.closest("[data-color]");
  if (!swatch) return;
  state.color = swatch.dataset.color;
  document.querySelectorAll(".swatch").forEach((node) => node.classList.toggle("on", node === swatch));
});
$("tag-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("tag-name").value.trim();
  if (!name) return;
  if (state.editingTag) {
    await api(`/api/tags/${state.editingTag.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name, color: state.color }),
    });
  } else {
    await api("/api/tags", { method: "POST", body: JSON.stringify({ name, color: state.color }) });
  }
  $("tag-dialog").close();
  await loadLibrary();
});

$("open-import").addEventListener("click", () => $("import-dialog").showModal());
$("close-import").addEventListener("click", () => $("import-dialog").close());

function refreshPreview() {
  const answer = $("paste-answer").value;
  $("paste-preview").innerHTML = answer.trim() ? renderMarkdown(answer) : "还没有内容";
  paintMermaid($("paste-preview"));
}

$("paste-answer").addEventListener("input", refreshPreview);
$("paste-answer").addEventListener("paste", async (event) => {
  const files = clipboardImageFiles(event.clipboardData);
  if (files.length) {
    event.preventDefault();
    const chunks = [];
    for (const file of files) {
      try {
        chunks.push(`![](${await uploadFile(file)})`);
      } catch (error) {
        $("paste-status").textContent = error.message;
      }
    }
    if (!chunks.length) return;
    insertInTextarea($("paste-answer"), `\n${chunks.join("\n")}\n`);
    refreshPreview();
    return;
  }
  const html = event.clipboardData?.getData("text/html") || "";
  const plain = event.clipboardData?.getData("text/plain") || "";
  const markdown = html ? htmlToMarkdown(html) : plain;
  const chosen =
    markdown.includes("```") || markdown.includes("**") || markdown.includes("\n- ") || markdown.includes("![")
      ? markdown
      : plain || markdown;
  if (!chosen) return;
  event.preventDefault();
  insertInTextarea($("paste-answer"), await localizeMarkdownImages(chosen));
  refreshPreview();
});

$("add-paste-image").addEventListener("click", () => $("paste-image-file").click());
$("paste-image-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    insertInTextarea($("paste-answer"), `\n![](${await uploadFile(file)})\n`);
    refreshPreview();
  } catch (error) {
    $("paste-status").textContent = error.message;
  }
});

$("edit-image-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file || !state.editing) return;
  try {
    insertImageNode(await uploadFile(file));
  } catch (error) {
    $("edit-status").textContent = error.message;
  }
});

$("save-paste").addEventListener("click", async () => {
  try {
    $("paste-status").textContent = "正在收藏…";
    const result = await api("/api/clips", {
      method: "POST",
      body: JSON.stringify({
        source: $("paste-source").value,
        title: $("paste-title").value,
        question: $("paste-question").value,
        answer: $("paste-answer").value,
      }),
    });
    $("paste-status").textContent = "已收藏这条回答。";
    $("paste-answer").value = "";
    $("paste-question").value = "";
    refreshPreview();
    $("import-dialog").close();
    await loadLibrary();
    if (result.id) await openConversation(result.id);
  } catch (error) {
    $("paste-status").textContent = error.message;
  }
});

document.addEventListener("selectionchange", () => {
  if (!state.editing) return;
  const body = $("answer-body");
  if (!body) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (body === range.commonAncestorContainer || body.contains(range.commonAncestorContainer)) {
    editRange = range.cloneRange();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
    event.preventDefault();
    $("search").focus();
  }
});

function rerenderMath() {
  if (state.editing) return;
  if (state.detail) renderReader();
  const box = $("paste-answer");
  if (box?.value.trim()) refreshPreview();
}

["katex-cdn", "mermaid-cdn"].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener("load", rerenderMath);
});

loadLibrary().catch((error) => {
  document.body.insertAdjacentHTML("beforeend", `<p class="empty">${escapeHtml(error.message)}</p>`);
});
