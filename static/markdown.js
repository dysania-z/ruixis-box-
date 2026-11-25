function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const MATH_ENV = /^(equation|align|gather|multline|eqnarray)\*?$/;
const MATH_FENCE = /^(math|latex|tex|katex)$/i;

function stashMath(source) {
  const slots = [];
  let out = "";
  const s = String(source);
  let i = 0;

  const push = (tex, display) => {
    out += `@@MATH${slots.length}@@`;
    slots.push({ tex: tex.replace(/^\n+|\n+$/g, ""), display });
  };

  while (i < s.length) {
    if (s.startsWith("```", i)) {
      const nl = s.indexOf("\n", i + 3);
      const lang = (nl < 0 ? s.slice(i + 3) : s.slice(i + 3, nl)).trim();
      const close = s.indexOf("```", nl < 0 ? i + 3 : nl + 1);
      if (close < 0) {
        out += s.slice(i);
        break;
      }
      if (MATH_FENCE.test(lang)) {
        const code = nl < 0 ? "" : s.slice(nl + 1, close);
        push(code.replace(/\n$/, ""), true);
        i = close + 3;
        continue;
      }
      out += s.slice(i, close + 3);
      i = close + 3;
      continue;
    }
    if (s[i] === "`") {
      const close = s.indexOf("`", i + 1);
      if (close < 0) {
        out += s.slice(i);
        break;
      }
      out += s.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (s.startsWith("$$", i)) {
      const close = s.indexOf("$$", i + 2);
      if (close < 0) {
        out += s.slice(i);
        break;
      }
      push(s.slice(i + 2, close), true);
      i = close + 2;
      continue;
    }
    if (s.startsWith("\\[", i)) {
      const close = s.indexOf("\\]", i + 2);
      if (close < 0) {
        out += s.slice(i);
        break;
      }
      push(s.slice(i + 2, close), true);
      i = close + 2;
      continue;
    }
    if (s.startsWith("\\(", i)) {
      const close = s.indexOf("\\)", i + 2);
      if (close < 0) {
        out += s.slice(i);
        break;
      }
      push(s.slice(i + 2, close), false);
      i = close + 2;
      continue;
    }
    if (s.startsWith("\\begin{", i)) {
      const nameEnd = s.indexOf("}", i + 7);
      const name = nameEnd < 0 ? "" : s.slice(i + 7, nameEnd);
      if (MATH_ENV.test(name)) {
        const close = s.indexOf(`\\end{${name}}`, nameEnd + 1);
        if (close < 0) {
          out += s.slice(i);
          break;
        }
        push(s.slice(i, close + 6 + name.length), true);
        i = close + 6 + name.length;
        continue;
      }
    }
    if (s[i] === "$" && s[i + 1] !== "$" && s[i + 1] && s[i + 1] !== " " && s[i + 1] !== "\n") {
      let j = i + 1;
      while (j < s.length && s[j] !== "\n") {
        if (s[j] === "\\") {
          j += 2;
          continue;
        }
        if (s[j] === "$") break;
        j += 1;
      }
      if (j < s.length && s[j] === "$" && s[j - 1] !== " " && j > i + 1) {
        push(s.slice(i + 1, j), false);
        i = j + 1;
        continue;
      }
    }
    out += s[i];
    i += 1;
  }
  return { text: out, slots };
}

function mathHtml(slot) {
  if (!slot) return "";
  const tex = slot.tex;
  const display = !!slot.display;
  let drawn = "";
  if (window.katex) {
    try {
      drawn = katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        strict: "ignore",
        output: "htmlAndMathml",
      });
    } catch (error) {
      drawn = `<code>${escapeHtml(tex)}</code>`;
    }
  } else {
    drawn = `<code>${escapeHtml(display ? `$$${tex}$$` : `$${tex}$`)}</code>`;
  }
  const src = escapeHtml(tex);
  if (display) {
    return `<div class="math-block" contenteditable="false"><pre class="math-src">${src}</pre>${drawn}</div>`;
  }
  return `<span class="math-inline" contenteditable="false"><span class="math-src">${src}</span>${drawn}</span>`;
}

function fillMath(html, slots) {
  let out = html.replace(/@@MATH(\d+)@@/g, (_, index) => mathHtml(slots[Number(index)]));
  return out.replace(/<p>\s*(<div class="math-block">[\s\S]*?<\/div>)\s*<\/p>/g, "$1");
}

function texFromKatex(node) {
  return (
    node.querySelector('.math-src')?.textContent ||
    node.querySelector('annotation[encoding="application/x-tex"]')?.textContent ||
    node.querySelector("annotation")?.textContent ||
    node.getAttribute("data-latex") ||
    ""
  ).trim();
}

function mathToMarkdown(tex, display) {
  if (!tex) return "";
  return display ? `\n$$\n${tex}\n$$\n` : `$${tex}$`;
}

function isMathChrome(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  const cls = node.classList;
  return (
    cls.contains("math-src") ||
    cls.contains("katex") ||
    cls.contains("katex-display") ||
    cls.contains("katex-html") ||
    cls.contains("katex-mathml")
  );
}

function strayAroundMath(node, walk) {
  return Array.from(node.childNodes)
    .map((child) => {
      if (child.nodeType === Node.TEXT_NODE) return child.textContent.replace(/\u00a0/g, " ");
      if (isMathChrome(child)) return "";
      return walk(child);
    })
    .join("");
}

function inlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(
    /!\[([^\]]*)\]\((\/media\/[0-9a-f]{32}\.(?:png|jpe?g|gif|webp|svg)|https?:\/\/[^\s)]+|data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+)\)/g,
    (_, alt, src) => `<img class="md-img" src="${src}" alt="${alt}">`
  );
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return html;
}

function stitchListMarkers(source) {
  return String(source)
    .replaceAll("\r\n", "\n")
    .replace(/^([ \t]*(?:[-*]|\d+\.)[ \t]*)\n+(?=\S)/gm, (_, marker) => (marker.endsWith(" ") ? marker : `${marker} `));
}

function readListItems(lines, i, isItem) {
  const items = [];
  while (i < lines.length) {
    let j = i;
    while (j < lines.length && !lines[j].trim()) j += 1;
    if (j >= lines.length || !isItem(lines[j])) break;
    i = j;
    let text = lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim();
    i += 1;
    if (!text) {
      while (i < lines.length && !lines[i].trim()) i += 1;
      if (
        i < lines.length &&
        !isItem(lines[i]) &&
        lines[i].trim() &&
        !lines[i].startsWith("```") &&
        !/^(#{1,4})\s+/.test(lines[i]) &&
        !lines[i].startsWith(">")
      ) {
        text = lines[i].trim();
        i += 1;
      }
    }
    items.push(text);
  }
  return { items, i };
}

function renderMarkdown(source) {
  const stashed = stashMath(String(source).replaceAll("\r\n", "\n"));
  return fillMath(renderMarkdownBody(stashed.text), stashed.slots);
}

function renderMarkdownBody(source) {
  const lines = stitchListMarkers(source).split("\n");
  const out = [];
  let i = 0;
  const fence = /^```(.*)$/;

  while (i < lines.length) {
    const line = lines[i];
    const fenced = line.match(fence);
    if (fenced) {
      const buf = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const langRaw = fenced[1].trim();
      const code = buf.join("\n");
      if (langRaw.toLowerCase() === "mermaid") {
        out.push(mermaidBlock(code));
        continue;
      }
      const svg = svgFromFence(langRaw, code);
      if (svg) {
        out.push(`<div class="diagram-svg">${svg}</div>`);
        continue;
      }
      const lang = escapeHtml(langRaw);
      out.push(`<pre><code${lang ? ` class="lang-${lang}"` : ""}>${escapeHtml(code)}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level + 1}>${inlineMarkdown(heading[2])}</h${level + 1}>`);
      i += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      out.push("<hr>");
      i += 1;
      continue;
    }
    if (line.startsWith(">")) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${inlineMarkdown(buf.join(" "))}</blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const list = readListItems(lines, i, (item) => /^\s*[-*]\s+/.test(item));
      out.push(`<ul>${list.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
      i = list.i;
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const list = readListItems(lines, i, (item) => /^\s*\d+\.\s+/.test(item));
      out.push(`<ol>${list.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ol>`);
      i = list.i;
      continue;
    }
    const pipeTable = readPipeTable(lines, i);
    if (pipeTable) {
      out.push(renderTable(pipeTable.rows));
      i = pipeTable.i;
      continue;
    }
    const tabRow = splitTabRow(line);
    if (tabRow) {
      const rows = [tabRow];
      let j = i + 1;
      while (j < lines.length && splitTabRow(lines[j])?.length === tabRow.length) {
        rows.push(splitTabRow(lines[j]));
        j += 1;
      }
      if (rows.length === 1) {
        const cells = [];
        while (j < lines.length && isTableCell(lines[j])) {
          cells.push(lines[j].trim());
          j += 1;
        }
        if (cells.length >= tabRow.length && cells.length % tabRow.length === 0) {
          for (let c = 0; c < cells.length; c += tabRow.length) rows.push(cells.slice(c, c + tabRow.length));
        }
      }
      if (rows.length > 1) {
        out.push(renderTable(rows));
        i = j;
        continue;
      }
    }
    if (i + 1 < lines.length && splitTabRow(lines[i + 1])) {
      const next = splitTabRow(lines[i + 1]);
      if (next.join("").replace(/\s/g, "") === line.replace(/\s/g, "")) {
        i += 1;
        continue;
      }
    }
    const buf = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith("```") &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !lines[i].startsWith(">")
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${inlineMarkdown(buf.join("\n")).replaceAll("\n", "<br>")}</p>`);
  }
  return out.join("");
}

function splitPipeRow(line) {
  if (!line.includes("|")) return null;
  const cells = line.split("|").map((cell) => cell.trim());
  if (cells[0] === "") cells.shift();
  if (cells[cells.length - 1] === "") cells.pop();
  return cells.length >= 2 ? cells : null;
}

function isSeparatorRow(row) {
  return row.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function readPipeTable(lines, i) {
  if (!splitPipeRow(lines[i])) return null;
  const rows = [];
  let j = i;
  while (j < lines.length) {
    const row = splitPipeRow(lines[j]);
    if (!row) break;
    if (!isSeparatorRow(row)) rows.push(row);
    j += 1;
    let next = j;
    while (next < lines.length && !lines[next].trim()) next += 1;
    if (next < lines.length && splitPipeRow(lines[next])) j = next;
    else break;
  }
  return rows.length > 1 ? { rows, i: j } : null;
}

function splitTabRow(line) {
  if (!line.includes("\t")) return null;
  const cells = line.split("\t").map((cell) => cell.trim());
  return cells.length >= 2 && cells.every(Boolean) ? cells : null;
}

function isTableCell(line) {
  const text = line.trim();
  return Boolean(text) && text.length <= 40 && !/[。！？]/.test(text) && !text.includes("\t") && !text.startsWith("#") && !text.startsWith("```");
}

function renderTable(rows) {
  const head = rows[0];
  const body = rows.slice(1);
  return `<div class="table-wrap"><table><thead><tr>${head.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${body
    .map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function mermaidBlock(code) {
  const source = escapeHtml(code);
  return `<div class="mermaid-wrap" contenteditable="false"><pre class="mermaid-src">${source}</pre><div class="mermaid">${source}</div></div>`;
}

function svgFromFence(lang, code) {
  if (lang.toLowerCase() !== "svg" && !/<svg[\s>]/i.test(code)) return "";
  const match = String(code).match(/<svg\b[\s\S]*<\/svg>/i);
  return match ? sanitizeSvg(match[0]) : "";
}

function sanitizeSvg(markup) {
  if (typeof DOMParser === "undefined") return "";
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const svg = parsed.documentElement;
  if (!svg || svg.tagName.toLowerCase() !== "svg" || parsed.querySelector("parsererror")) return "";
  svg.querySelectorAll("script, foreignObject").forEach((node) => node.remove());
  for (const node of [svg, ...svg.querySelectorAll("*")]) {
    for (const attr of [...node.attributes]) {
      if (/^on/i.test(attr.name) || (attr.name === "href" && /^\s*javascript:/i.test(attr.value))) {
        node.removeAttribute(attr.name);
      }
    }
  }
  if (!svg.getAttribute("xmlns")) svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new XMLSerializer().serializeToString(svg);
}

function serializeSvg(svg) {
  return sanitizeSvg(svg.outerHTML);
}

let mermaidReady = false;

async function paintMermaid(root) {
  if (!window.mermaid || !root) return;
  if (!mermaidReady) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        fontFamily: "Outfit, sans-serif",
        primaryColor: "#f6efe4",
        primaryTextColor: "#1c1712",
        primaryBorderColor: "#c4b49a",
        lineColor: "#6b4a2a",
        secondaryColor: "#fffdf9",
        tertiaryColor: "#faf6ee",
        clusterBkg: "#fffdf9",
        clusterBorder: "#d9cbb8",
        edgeLabelBackground: "#faf6ee",
      },
    });
    mermaidReady = true;
  }
  const nodes = [...root.querySelectorAll(".mermaid")].filter((node) => !node.getAttribute("data-processed"));
  if (!nodes.length) return;
  try {
    await mermaid.run({ nodes });
  } catch (error) {
    console.warn(error);
  }
}

function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/\u00a0/g, " ");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toLowerCase();
    if (tag === "script") {
      const type = (node.getAttribute("type") || "").toLowerCase();
      if (type.includes("math/tex")) {
        return mathToMarkdown(node.textContent.trim(), type.includes("display"));
      }
      return "";
    }
    if (tag === "style") return "";
    if (node.classList.contains("math-inline")) {
      return mathToMarkdown(texFromKatex(node), false) + strayAroundMath(node, walk);
    }
    if (node.classList.contains("math-block") || node.classList.contains("katex-display")) {
      return mathToMarkdown(texFromKatex(node), true) + strayAroundMath(node, walk);
    }
    if (node.classList.contains("katex")) {
      if (node.closest(".katex-display, .math-block, .math-inline")) return "";
      return mathToMarkdown(texFromKatex(node), false) + strayAroundMath(node, walk);
    }
    if (node.classList.contains("katex-html") || node.classList.contains("katex-mathml")) return "";
    if (tag === "mjx-container") {
      return mathToMarkdown(texFromKatex(node), node.getAttribute("display") === "true");
    }
    const inner = () => Array.from(node.childNodes).map(walk).join("");
    if (tag === "br") return "\n";
    if (tag === "div" && node.classList.contains("mermaid-wrap")) {
      const src = node.querySelector(".mermaid-src")?.textContent.replace(/\n$/, "") || "";
      if (src.trim()) return `\n\`\`\`mermaid\n${src}\n\`\`\`\n`;
      const drawn = node.querySelector("svg");
      if (drawn) return `\n\`\`\`svg\n${serializeSvg(drawn)}\n\`\`\`\n`;
      return "";
    }
    if (tag === "svg") return `\n\`\`\`svg\n${serializeSvg(node)}\n\`\`\`\n`;
    if (tag === "pre") {
      if (node.classList.contains("math-src") || node.closest(".math-block, .math-inline")) return "";
      const nested = node.querySelector("svg");
      if (nested) return `\n\`\`\`svg\n${serializeSvg(nested)}\n\`\`\`\n`;
      const code = node.textContent.replace(/\n$/, "");
      return `\n\`\`\`\n${code}\n\`\`\`\n`;
    }
    if (tag === "img") {
      const src = (node.getAttribute("src") || "").trim();
      const alt = (node.getAttribute("alt") || "").replace(/[\[\]]/g, "");
      return src && !src.startsWith("blob:") ? `\n![${alt}](${src})\n` : "";
    }
    if (tag === "code" && node.parentElement?.tagName.toLowerCase() !== "pre") return `\`${node.textContent}\``;
    if (/^h[1-6]$/.test(tag)) return `\n${"#".repeat(Number(tag[1]))} ${inner().trim()}\n`;
    if (tag === "strong" || tag === "b") return `**${inner()}**`;
    if (tag === "em" || tag === "i") return `*${inner()}*`;
    if (tag === "a") {
      const img = node.querySelector(":scope > img");
      if (img && node.childNodes.length === 1) return walk(img);
      const href = node.getAttribute("href") || "";
      const text = inner().trim();
      return href.startsWith("http") ? `[${text}](${href})` : text;
    }
    if (tag === "table") {
      const matrix = Array.from(node.querySelectorAll("tr")).map((row) =>
        Array.from(row.children)
          .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
          .map((cell) => walk(cell).replace(/\s+/g, " ").trim())
      ).filter((row) => row.length);
      if (!matrix.length) return "";
      const width = Math.max(...matrix.map((row) => row.length));
      const lined = matrix.map((row) => `| ${Array.from({ length: width }, (_, index) => row[index] || "").join(" | ")} |`);
      lined.splice(1, 0, `| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
      return `\n${lined.join("\n")}\n`;
    }
    if (tag === "thead" || tag === "tbody" || tag === "tfoot" || tag === "tr" || tag === "th" || tag === "td") return inner();
    if (tag === "li") return inner().replace(/\n+/g, " ").trim();
    if (tag === "ul") return `\n${Array.from(node.children).map((li) => `- ${walk(li).trim()}`).join("\n")}\n`;
    if (tag === "ol") return `\n${Array.from(node.children).map((li, index) => `${index + 1}. ${walk(li).trim()}`).join("\n")}\n`;
    if (tag === "blockquote") return `\n> ${inner().trim().replaceAll("\n", "\n> ")}\n`;
    if (tag === "p" || tag === "div" || tag === "section" || tag === "article" || tag === "figure") {
      const nested = node.querySelector(":scope > svg");
      if (nested) return `\n\`\`\`svg\n${serializeSvg(nested)}\n\`\`\`\n`;
      const text = inner().trim();
      if (node.closest("li")) return text;
      return `\n${text}\n`;
    }
    return inner();
  };
  return stitchPipeTableGaps(walk(doc.body).replace(/\n{3,}/g, "\n\n")).trim();
}

function stitchPipeTableGaps(text) {
  return String(text).replace(/(\|[^\n]*\|)\n\n(?=\|[^\n]*\|)/g, "$1\n");
}
