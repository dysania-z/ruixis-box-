function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^\*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return html;
}

function renderMarkdown(source) {
  const lines = String(source).replaceAll("\r\n", "\n").split("\n");
  const out = [];
  let i = 0;
  const fence = /^```(.*)$/;

  while (i < lines.length) {
    const line = lines[i];
    const fenced = line.match(fence);
    if (fenced) {
      const lang = escapeHtml(fenced[1].trim());
      const buf = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      out.push(`<pre><code${lang ? ` class="lang-${lang}"` : ""}>${escapeHtml(buf.join("\n"))}</code></pre>`);
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
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inlineMarkdown(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inlineMarkdown(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const cells = (row) => row.split("|").map((cell) => cell.trim()).filter((cell, index, all) => !(cell === "" && (index === 0 || index === all.length - 1)));
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        body.push(cells(lines[i]));
        i += 1;
      }
      out.push(
        `<table><thead><tr>${head.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${body
          .map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`
      );
      continue;
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

function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/\u00a0/g, " ");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toLowerCase();
    if (tag === "script" || tag === "style") return "";
    const inner = () => Array.from(node.childNodes).map(walk).join("");
    if (tag === "br") return "\n";
    if (tag === "pre") {
      const code = node.textContent.replace(/\n$/, "");
      return `\n\`\`\`\n${code}\n\`\`\`\n`;
    }
    if (tag === "code" && node.parentElement?.tagName.toLowerCase() !== "pre") return `\`${node.textContent}\``;
    if (/^h[1-6]$/.test(tag)) return `\n${"#".repeat(Number(tag[1]))} ${inner().trim()}\n`;
    if (tag === "strong" || tag === "b") return `**${inner()}**`;
    if (tag === "em" || tag === "i") return `*${inner()}*`;
    if (tag === "a") {
      const href = node.getAttribute("href") || "";
      const text = inner().trim();
      return href.startsWith("http") ? `[${text}](${href})` : text;
    }
    if (tag === "li") return inner().trim();
    if (tag === "ul") return `\n${Array.from(node.children).map((li) => `- ${walk(li).trim()}`).join("\n")}\n`;
    if (tag === "ol") return `\n${Array.from(node.children).map((li, index) => `${index + 1}. ${walk(li).trim()}`).join("\n")}\n`;
    if (tag === "blockquote") return `\n> ${inner().trim().replaceAll("\n", "\n> ")}\n`;
    if (tag === "p" || tag === "div" || tag === "section" || tag === "article") return `\n${inner().trim()}\n`;
    return inner();
  };
  return walk(doc.body).replace(/\n{3,}/g, "\n\n").trim();
}
