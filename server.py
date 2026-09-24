#!/usr/bin/env python3
"""Ruixi's Box — local library for AI conversations."""

from __future__ import annotations

import json
import re
import sqlite3
from html.parser import HTMLParser
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DB_PATH = Path.home() / ".ruixis-box" / "library.db"
HOST = "127.0.0.1"
PORT = 8787

TAG_COLORS = [
    "#7f1d1d", "#b60205", "#e03e3e", "#f4c7c3",
    "#9a3412", "#d93f0b", "#f97316", "#f9d0c4",
    "#92400e", "#b45309", "#d97706", "#fde68a",
    "#a16207", "#ca8a04", "#fbca04", "#fef2c0",
    "#3f6212", "#4d7c0f", "#65a30d", "#d9f99d",
    "#14532d", "#0e8a16", "#22c55e", "#c2e0c6",
    "#134e4a", "#0f7b6c", "#0d9488", "#bfdadc",
    "#155e75", "#0891b2", "#06b6d4", "#cffafe",
    "#1e3a8a", "#1d76db", "#3b82f6", "#c5def5",
    "#312e81", "#4338ca", "#6366f1", "#c7d2fe",
    "#4c1d95", "#5319e7", "#7c3aed", "#d4c5f9",
    "#831843", "#ad1a72", "#db2777", "#fbcfe8",
]

ROLE_LINE = re.compile(
    r"^\s*(?:#{1,3}\s*)?(?:\*\*)?"
    r"(user|assistant|human|chatgpt|deepseek|codex|cursor|system|"
    r"用户|助手|我|你|人类|人工智能)"
    r"(?:\*\*)?\s*[:：]\s*(.*)$",
    re.IGNORECASE,
)
ROLE_MAP = {
    "user": "user",
    "human": "user",
    "用户": "user",
    "我": "user",
    "人类": "user",
    "assistant": "assistant",
    "chatgpt": "assistant",
    "deepseek": "assistant",
    "codex": "assistant",
    "cursor": "assistant",
    "助手": "assistant",
    "你": "assistant",
    "人工智能": "assistant",
    "system": "system",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            external_id TEXT UNIQUE,
            source TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL DEFAULT '',
            preview TEXT NOT NULL DEFAULT '',
            created_at TEXT,
            updated_at TEXT,
            imported_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            position INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            color TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS conversation_tags (
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (conversation_id, tag_id)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, position);
        CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
        """
    )
    return conn


def clip(text: str, limit: int = 72) -> str:
    flat = re.sub(r"\s+", " ", text).strip()
    if len(flat) <= limit:
        return flat
    return flat[: limit - 1] + "…"


def text_from_parts(content) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, dict):
        if isinstance(content.get("text"), str):
            return content["text"].strip()
        parts = content.get("parts") or content.get("content")
        return text_from_parts(parts)
    if isinstance(content, list):
        chunks = []
        for part in content:
            if isinstance(part, str):
                if part.strip():
                    chunks.append(part.strip())
                continue
            if not isinstance(part, dict):
                continue
            kind = part.get("type") or ""
            if kind in {"tool_use", "tool_result", "function_call", "function_call_output", "reasoning"}:
                continue
            text = part.get("text") or part.get("output_text") or part.get("input_text")
            if isinstance(text, str) and text.strip():
                chunks.append(text.strip())
        return "\n\n".join(chunks).strip()
    return ""


def normalize_messages(raw: list[dict]) -> list[dict]:
    messages = []
    for item in raw:
        role = item.get("role") or "user"
        if role not in {"user", "assistant", "system"}:
            role = "user" if role in {"human"} else "assistant"
        content = (item.get("content") or "").strip()
        if not content:
            continue
        if role == "system":
            continue
        messages.append({"role": role, "content": content})
    return messages


def title_from_messages(messages: list[dict], fallback: str = "未命名对话") -> str:
    for msg in messages:
        if msg["role"] == "user" and msg["content"].strip():
            return clip(msg["content"], 42) or fallback
    if messages:
        return clip(messages[0]["content"], 42) or fallback
    return fallback


def body_from_messages(messages: list[dict]) -> str:
    return "\n".join(f"{m['role']}\n{m['content']}" for m in messages)


def parse_cursor_file(path: Path) -> dict | None:
    messages = []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        role = obj.get("role") or "assistant"
        content = text_from_parts((obj.get("message") or {}).get("content"))
        if content:
            messages.append({"role": role, "content": content})
    messages = normalize_messages(messages)
    if not messages:
        return None
    project = ""
    parts = path.parts
    if "projects" in parts:
        idx = parts.index("projects")
        if idx + 1 < len(parts):
            project = parts[idx + 1].replace("-", " ")
    external = f"cursor:{path.stem}"
    mtime = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
    title = title_from_messages(messages)
    if project and project not in title:
        title = clip(f"{title}", 42)
    return {
        "external_id": external,
        "source": "cursor",
        "title": title,
        "created_at": mtime,
        "updated_at": mtime,
        "messages": messages,
        "origin": str(path),
    }


def parse_codex_file(path: Path) -> dict | None:
    messages = []
    session_id = path.stem
    created = None
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") == "session_meta":
            payload = obj.get("payload") or {}
            session_id = payload.get("session_id") or payload.get("id") or session_id
            created = payload.get("timestamp") or obj.get("timestamp")
            continue
        if obj.get("type") != "response_item":
            continue
        payload = obj.get("payload") or {}
        if payload.get("type") != "message":
            continue
        role = payload.get("role") or "assistant"
        if role == "developer":
            continue
        content = text_from_parts(payload.get("content"))
        if content:
            messages.append({"role": role, "content": content})
    messages = normalize_messages(messages)
    if not messages:
        return None
    mtime = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
    created = created or mtime
    return {
        "external_id": f"codex:{session_id}",
        "source": "codex",
        "title": title_from_messages(messages),
        "created_at": created,
        "updated_at": mtime,
        "messages": messages,
    }


def walk_chatgpt_mapping(mapping: dict) -> list[dict]:
    nodes = []
    for node in mapping.values():
        message = (node or {}).get("message") or {}
        author = (message.get("author") or {}).get("role") or ""
        content = text_from_parts(message.get("content"))
        if author in {"user", "assistant"} and content:
            nodes.append(
                {
                    "role": author,
                    "content": content,
                    "time": message.get("create_time") or 0,
                }
            )
    nodes.sort(key=lambda item: item["time"] or 0)
    return [{"role": n["role"], "content": n["content"]} for n in nodes]


def conversations_from_json(data, source: str) -> list[dict]:
    found = []
    items = data if isinstance(data, list) else [data]
    for item in items:
        if not isinstance(item, dict):
            continue
        messages = []
        if isinstance(item.get("mapping"), dict):
            messages = walk_chatgpt_mapping(item["mapping"])
        elif isinstance(item.get("messages"), list):
            for msg in item["messages"]:
                if not isinstance(msg, dict):
                    continue
                role = msg.get("role") or (msg.get("author") or {}).get("role") or "user"
                content = text_from_parts(msg.get("content") if "content" in msg else msg)
                if content:
                    messages.append({"role": role, "content": content})
        elif isinstance(item.get("conversation"), list):
            return conversations_from_json(item["conversation"], source)
        messages = normalize_messages(messages)
        if not messages:
            continue
        created = item.get("create_time") or item.get("created_at") or item.get("inserted_at")
        updated = item.get("update_time") or item.get("updated_at") or created
        if isinstance(created, (int, float)):
            created = datetime.fromtimestamp(created, timezone.utc).isoformat(timespec="seconds")
        if isinstance(updated, (int, float)):
            updated = datetime.fromtimestamp(updated, timezone.utc).isoformat(timespec="seconds")
        ext = item.get("id") or item.get("conversation_id") or uuid.uuid4().hex
        found.append(
            {
                "external_id": f"{source}:{ext}",
                "source": source,
                "title": item.get("title") or title_from_messages(messages),
                "created_at": created or now_iso(),
                "updated_at": updated or now_iso(),
                "messages": messages,
            }
        )
    return found


def parse_role_transcript(text: str) -> list[dict]:
    messages = []
    current_role = None
    buffer: list[str] = []

    def flush():
        if current_role and buffer:
            content = "\n".join(buffer).strip()
            if content:
                messages.append({"role": current_role, "content": content})

    for line in text.splitlines():
        match = ROLE_LINE.match(line)
        if match:
            flush()
            current_role = ROLE_MAP.get(match.group(1).lower(), "assistant")
            buffer = [match.group(2)] if match.group(2) else []
        elif current_role:
            buffer.append(line)
    flush()
    return normalize_messages(messages)


def parse_pasted(text: str, source: str, title: str | None) -> dict:
    text = text.strip()
    if text.startswith("{") or text.startswith("["):
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            data = None
        if data is not None:
            convos = conversations_from_json(data, source)
            if len(convos) == 1:
                if title:
                    convos[0]["title"] = title
                convos[0]["external_id"] = f"{source}:paste:{uuid.uuid4().hex}"
                return convos[0]
            if len(convos) > 1:
                return {"many": convos}
    messages = parse_role_transcript(text)
    if not messages:
        messages = [{"role": "user", "content": text}]
    return {
        "external_id": f"{source}:paste:{uuid.uuid4().hex}",
        "source": source,
        "title": title or title_from_messages(messages),
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "messages": messages,
    }


def upsert_conversation(conn: sqlite3.Connection, convo: dict) -> str:
    messages = normalize_messages(convo["messages"])
    if not messages:
        return "skipped"
    body = body_from_messages(messages)
    preview = clip(next((m["content"] for m in messages if m["role"] == "assistant"), messages[0]["content"]), 120)
    existing = conn.execute(
        "SELECT id FROM conversations WHERE external_id = ?",
        (convo["external_id"],),
    ).fetchone()
    imported = now_iso()
    if existing:
        cid = existing["id"]
        conn.execute("DELETE FROM messages WHERE conversation_id = ?", (cid,))
        conn.execute(
            """
            UPDATE conversations
            SET title = ?, body = ?, preview = ?, source = ?, created_at = ?, updated_at = ?, imported_at = ?
            WHERE id = ?
            """,
            (
                convo["title"],
                body,
                preview,
                convo["source"],
                convo.get("created_at"),
                convo.get("updated_at"),
                imported,
                cid,
            ),
        )
        status = "updated"
    else:
        cid = uuid.uuid4().hex
        conn.execute(
            """
            INSERT INTO conversations (id, external_id, source, title, body, preview, created_at, updated_at, imported_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                cid,
                convo["external_id"],
                convo["source"],
                convo["title"],
                body,
                preview,
                convo.get("created_at"),
                convo.get("updated_at"),
                imported,
            ),
        )
        status = "added"
    conn.executemany(
        "INSERT INTO messages (conversation_id, role, content, position) VALUES (?, ?, ?, ?)",
        [(cid, m["role"], m["content"], i) for i, m in enumerate(messages)],
    )
    return status


def scan_sources(conn: sqlite3.Connection, sources: list[str]) -> dict:
    files: list[tuple[str, Path]] = []
    if "cursor" in sources:
        root = Path.home() / ".cursor" / "projects"
        if root.exists():
            for path in root.rglob("*.jsonl"):
                if "agent-transcripts" not in path.parts or "subagents" in path.parts:
                    continue
                files.append(("cursor", path))
    if "codex" in sources:
        root = Path.home() / ".codex" / "sessions"
        if root.exists():
            for path in root.rglob("*.jsonl"):
                files.append(("codex", path))
    added = updated = skipped = 0
    for kind, path in files:
        convo = parse_cursor_file(path) if kind == "cursor" else parse_codex_file(path)
        if not convo:
            skipped += 1
            continue
        status = upsert_conversation(conn, convo)
        if status == "added":
            added += 1
        elif status == "updated":
            updated += 1
        else:
            skipped += 1
    conn.commit()
    return {"scanned": len(files), "added": added, "updated": updated, "skipped": skipped}


def save_import(conn: sqlite3.Connection, convo_or_many: dict) -> dict:
    items = convo_or_many.get("many") if isinstance(convo_or_many, dict) and "many" in convo_or_many else [convo_or_many]
    added = updated = 0
    last_id = None
    for convo in items:
        status = upsert_conversation(conn, convo)
        if status == "added":
            added += 1
        elif status == "updated":
            updated += 1
        row = conn.execute(
            "SELECT id FROM conversations WHERE external_id = ?",
            (convo["external_id"],),
        ).fetchone()
        if row:
            last_id = row["id"]
    conn.commit()
    return {"added": added, "updated": updated, "id": last_id, "count": len(items)}


def list_tags(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """
        SELECT t.id, t.name, t.color, COUNT(ct.conversation_id) AS count
        FROM tags t
        LEFT JOIN conversation_tags ct ON ct.tag_id = t.id
        GROUP BY t.id
        ORDER BY t.name COLLATE NOCASE
        """
    ).fetchall()
    return [dict(row) for row in rows]


def list_conversations(conn: sqlite3.Connection, query: str, tag_id: str | None) -> list[dict]:
    sql = """
        SELECT c.id, c.source, c.title, c.preview, c.created_at, c.updated_at,
               GROUP_CONCAT(t.id || '|' || t.name || '|' || t.color, '\n') AS tag_blob
        FROM conversations c
        LEFT JOIN conversation_tags ct ON ct.conversation_id = c.id
        LEFT JOIN tags t ON t.id = ct.tag_id
    """
    where = []
    params: list = []
    if tag_id:
        where.append(
            "c.id IN (SELECT conversation_id FROM conversation_tags WHERE tag_id = ?)"
        )
        params.append(int(tag_id))
    terms = [term for term in re.split(r"\s+", query.strip()) if term]
    for term in terms:
        where.append("(c.title LIKE ? OR c.body LIKE ?)")
        like = f"%{term}%"
        params.extend([like, like])
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " GROUP BY c.id ORDER BY COALESCE(c.updated_at, c.imported_at) DESC"
    rows = conn.execute(sql, params).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        tags = []
        if item.get("tag_blob"):
            for chunk in item["tag_blob"].split("\n"):
                tid, name, color = chunk.split("|", 2)
                tags.append({"id": int(tid), "name": name, "color": color})
        item["tags"] = tags
        del item["tag_blob"]
        result.append(item)
    return result


def get_conversation(conn: sqlite3.Connection, cid: str) -> dict | None:
    row = conn.execute("SELECT * FROM conversations WHERE id = ?", (cid,)).fetchone()
    if not row:
        return None
    item = dict(row)
    del item["body"]
    messages = conn.execute(
        "SELECT role, content, position FROM messages WHERE conversation_id = ? ORDER BY position",
        (cid,),
    ).fetchall()
    item["messages"] = [dict(m) for m in messages]
    tags = conn.execute(
        """
        SELECT t.id, t.name, t.color
        FROM tags t
        JOIN conversation_tags ct ON ct.tag_id = t.id
        WHERE ct.conversation_id = ?
        ORDER BY t.name COLLATE NOCASE
        """,
        (cid,),
    ).fetchall()
    item["tags"] = [dict(t) for t in tags]
    return item


class HtmlToMarkdown(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.skip = 0
        self.in_pre = 0
        self.list_stack: list[str] = []
        self.ol_index: list[int] = []

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.skip += 1
            return
        if tag == "br":
            self.parts.append("\n")
        elif tag == "pre":
            self.in_pre += 1
            self.parts.append("\n```\n")
        elif tag == "code" and not self.in_pre:
            self.parts.append("`")
        elif tag in {"strong", "b"}:
            self.parts.append("**")
        elif tag in {"em", "i"}:
            self.parts.append("*")
        elif tag in {"h1", "h2", "h3", "h4"}:
            self.parts.append("\n" + "#" * int(tag[1]) + " ")
        elif tag == "li":
            kind = self.list_stack[-1] if self.list_stack else "ul"
            if kind == "ol":
                self.ol_index[-1] += 1
                self.parts.append(f"\n{self.ol_index[-1]}. ")
            else:
                self.parts.append("\n- ")
        elif tag == "ul":
            self.list_stack.append("ul")
        elif tag == "ol":
            self.list_stack.append("ol")
            self.ol_index.append(0)
        elif tag == "p":
            self.parts.append("\n")
        elif tag == "blockquote":
            self.parts.append("\n> ")

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.skip = max(0, self.skip - 1)
            return
        if tag == "pre":
            self.in_pre = max(0, self.in_pre - 1)
            self.parts.append("\n```\n")
        elif tag == "code" and not self.in_pre:
            self.parts.append("`")
        elif tag in {"strong", "b"}:
            self.parts.append("**")
        elif tag in {"em", "i"}:
            self.parts.append("*")
        elif tag in {"h1", "h2", "h3", "h4", "p", "li"}:
            self.parts.append("\n")
        elif tag == "ul" and self.list_stack:
            self.list_stack.pop()
            self.parts.append("\n")
        elif tag == "ol" and self.list_stack:
            self.list_stack.pop()
            if self.ol_index:
                self.ol_index.pop()
            self.parts.append("\n")

    def handle_data(self, data):
        if self.skip:
            return
        self.parts.append(data.replace("\xa0", " "))


def html_to_markdown(raw: str) -> str:
    parser = HtmlToMarkdown()
    parser.feed(raw)
    text = "".join(parser.parts)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text


def save_clip(conn: sqlite3.Connection, source: str, title: str, question: str, answer: str) -> dict:
    answer = answer.replace("\r\n", "\n")
    question = question.replace("\r\n", "\n").strip()
    if not answer.strip():
        raise ValueError("empty")
    messages = []
    if question:
        messages.append({"role": "user", "content": question})
    messages.append({"role": "assistant", "content": answer})
    heading = title.strip() or (clip(question, 42) if question else title_from_messages(messages))
    return save_import(
        conn,
        {
            "external_id": f"{source}:clip:{uuid.uuid4().hex}",
            "source": source if source in {"cursor", "codex", "chatgpt", "deepseek", "other"} else "other",
            "title": heading,
            "created_at": now_iso(),
            "updated_at": now_iso(),
            "messages": messages,
        },
    )


def read_json(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length") or 0)
    raw = handler.rfile.read(length) if length else b"{}"
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f"[ruixis] {self.address_string()} {fmt % args}")

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def send_json(self, payload, status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send_file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(404)
            return
        kind = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
        }.get(path.suffix, "application/octet-stream")
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/":
            self.send_file(STATIC / "index.html")
            return
        if path.startswith("/static/"):
            rel = path.removeprefix("/static/")
            target = (STATIC / rel).resolve()
            if STATIC.resolve() not in target.parents and target != STATIC.resolve():
                self.send_error(403)
                return
            self.send_file(target)
            return
        conn = connect()
        try:
            if path == "/api/library":
                qs = parse_qs(parsed.query)
                query = (qs.get("q") or [""])[0]
                tag = (qs.get("tag") or [None])[0]
                convos = list_conversations(conn, query, tag)
                total = conn.execute("SELECT COUNT(*) AS n FROM conversations").fetchone()["n"]
                self.send_json({"conversations": convos, "tags": list_tags(conn), "total": total})
                return
            if path.startswith("/api/conversations/"):
                cid = path.rsplit("/", 1)[-1]
                item = get_conversation(conn, cid)
                if not item:
                    self.send_json({"error": "找不到这条对话"}, 404)
                    return
                self.send_json(item)
                return
            self.send_json({"error": "未知路径"}, 404)
        finally:
            conn.close()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        conn = connect()
        try:
            if parsed.path == "/capture":
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length).decode("utf-8", errors="replace")
                form = parse_qs(raw)
                source = (form.get("source") or ["other"])[0]
                title = (form.get("title") or [""])[0]
                question = (form.get("question") or [""])[0]
                answer = (form.get("answer") or [""])[0]
                if "<" in answer and ">" in answer:
                    answer = html_to_markdown(answer)
                try:
                    result = save_clip(conn, source, title, question, answer)
                except ValueError:
                    page = "<!doctype html><meta charset=utf-8><title>没收藏上</title><p>没有选中回答。</p>"
                    data = page.encode()
                    self.send_response(400)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                page = (
                    "<!doctype html><meta charset=utf-8><title>已收藏</title>"
                    "<body style=\"font-family:sans-serif;padding:48px\">"
                    f"<h1>已放进 Ruixi's Box</h1><p>共收藏这段回答。</p>"
                    "<p><a href=\"/\">打开匣子</a></p></body>"
                )
                data = page.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            body = read_json(self)
            if parsed.path == "/api/clips":
                try:
                    result = save_clip(
                        conn,
                        body.get("source") or "other",
                        body.get("title") or "",
                        body.get("question") or "",
                        body.get("answer") or "",
                    )
                except ValueError:
                    self.send_json({"error": "回答是空的"}, 400)
                    return
                self.send_json(result)
                return
            if parsed.path == "/api/import/scan":
                sources = body.get("sources") or ["cursor", "codex"]
                self.send_json(scan_sources(conn, sources))
                return
            if parsed.path == "/api/import/text":
                text = (body.get("text") or "").strip()
                if not text:
                    self.send_json({"error": "内容是空的"}, 400)
                    return
                source = body.get("source") or "other"
                parsed_convo = parse_pasted(text, source, (body.get("title") or "").strip() or None)
                self.send_json(save_import(conn, parsed_convo))
                return
            if parsed.path == "/api/tags":
                name = (body.get("name") or "").strip()
                if not name:
                    self.send_json({"error": "标签名不能为空"}, 400)
                    return
                count = conn.execute("SELECT COUNT(*) AS n FROM tags").fetchone()["n"]
                color = body.get("color") or TAG_COLORS[count % len(TAG_COLORS)]
                try:
                    cur = conn.execute("INSERT INTO tags (name, color) VALUES (?, ?)", (name, color))
                except sqlite3.IntegrityError:
                    self.send_json({"error": "已经有同名标签"}, 409)
                    return
                conn.commit()
                self.send_json({"id": cur.lastrowid, "name": name, "color": color, "count": 0})
                return
            self.send_json({"error": "未知路径"}, 404)
        except json.JSONDecodeError:
            self.send_json({"error": "请求不是合法的 JSON"}, 400)
        finally:
            conn.close()

    def do_PATCH(self) -> None:
        parsed = urlparse(self.path)
        conn = connect()
        try:
            body = read_json(self)
            parts = [p for p in parsed.path.split("/") if p]
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "conversations":
                cid = parts[2]
                if "answer" in body:
                    exists = conn.execute("SELECT id FROM conversations WHERE id = ?", (cid,)).fetchone()
                    if not exists:
                        self.send_json({"error": "找不到这条收藏"}, 404)
                        return
                    answer = str(body.get("answer") or "").replace("\r\n", "\n")
                    question = str(body.get("question") or "").replace("\r\n", "\n").strip()
                    if not answer.strip():
                        self.send_json({"error": "回答不能为空"}, 400)
                        return
                    messages = []
                    if question:
                        messages.append({"role": "user", "content": question})
                    messages.append({"role": "assistant", "content": answer})
                    conn.execute("DELETE FROM messages WHERE conversation_id = ?", (cid,))
                    conn.executemany(
                        "INSERT INTO messages (conversation_id, role, content, position) VALUES (?, ?, ?, ?)",
                        [(cid, m["role"], m["content"], i) for i, m in enumerate(messages)],
                    )
                    conn.execute(
                        "UPDATE conversations SET body = ?, preview = ?, updated_at = ? WHERE id = ?",
                        (body_from_messages(messages), clip(answer, 120), now_iso(), cid),
                    )
                    conn.commit()
                    self.send_json({"ok": True})
                    return
                title = (body.get("title") or "").strip()
                if not title:
                    self.send_json({"error": "标题不能为空"}, 400)
                    return
                cur = conn.execute("UPDATE conversations SET title = ? WHERE id = ?", (title, cid))
                conn.commit()
                if cur.rowcount == 0:
                    self.send_json({"error": "找不到这条对话"}, 404)
                    return
                self.send_json({"ok": True})
                return
            if len(parts) == 4 and parts[:3] == ["api", "conversations", "tags"]:
                self.send_json({"error": "请使用 PUT"}, 405)
                return
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "tags":
                tag_id = int(parts[2])
                name = (body.get("name") or "").strip()
                color = body.get("color")
                if name:
                    try:
                        conn.execute("UPDATE tags SET name = ? WHERE id = ?", (name, tag_id))
                    except sqlite3.IntegrityError:
                        self.send_json({"error": "已经有同名标签"}, 409)
                        return
                if color:
                    conn.execute("UPDATE tags SET color = ? WHERE id = ?", (color, tag_id))
                conn.commit()
                self.send_json({"ok": True})
                return
            self.send_json({"error": "未知路径"}, 404)
        finally:
            conn.close()

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        conn = connect()
        try:
            parts = [p for p in parsed.path.split("/") if p]
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "conversations" and parts[3] == "tags":
                cid = parts[2]
                body = read_json(self)
                tag_ids = [int(x) for x in body.get("tagIds") or []]
                exists = conn.execute("SELECT id FROM conversations WHERE id = ?", (cid,)).fetchone()
                if not exists:
                    self.send_json({"error": "找不到这条对话"}, 404)
                    return
                conn.execute("DELETE FROM conversation_tags WHERE conversation_id = ?", (cid,))
                conn.executemany(
                    "INSERT INTO conversation_tags (conversation_id, tag_id) VALUES (?, ?)",
                    [(cid, tid) for tid in tag_ids],
                )
                conn.commit()
                self.send_json({"ok": True})
                return
            self.send_json({"error": "未知路径"}, 404)
        finally:
            conn.close()

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        conn = connect()
        try:
            parts = [p for p in parsed.path.split("/") if p]
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "conversations":
                conn.execute("DELETE FROM conversations WHERE id = ?", (parts[2],))
                conn.commit()
                self.send_json({"ok": True})
                return
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "tags":
                conn.execute("DELETE FROM tags WHERE id = ?", (int(parts[2]),))
                conn.commit()
                self.send_json({"ok": True})
                return
            self.send_json({"error": "未知路径"}, 404)
        finally:
            conn.close()


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Ruixi's Box 已打开  http://{HOST}:{PORT}")
    print(f"数据库  {DB_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
