#!/usr/bin/env python3
"""
Does what index.html does (anonymous Supabase session -> link_guest_ip ->
set_duck_identity -> refresh token), then fetches the page the iframe would
have loaded and crawls it (same origin) into ref/.

Config constants are read from index.html so there is one source of truth.
The token is never written to disk; saved files are the page's own assets.
"""
import json, os, re, sys, urllib.request, urllib.parse, urllib.error, hashlib
from html.parser import HTMLParser
from collections import deque

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "ref")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
MAX_FILES = int(os.environ.get("MAX_FILES", "2000"))

src = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
def const(name):
    m = re.search(r'const\s+%s\s*=\s*"([^"]+)"' % name, src)
    if not m: sys.exit(f"missing constant {name} in index.html")
    return m.group(1)

MAIN_URL, MAIN_KEY = const("MAIN_SUPABASE_URL"), const("MAIN_SUPABASE_ANON_KEY")
LB_URL, LB_KEY = const("LEADERBOARD_URL"), const("LEADERBOARD_ANON_KEY")
m = re.search(r"iframe\.src\s*=\s*`(https://[^/?`]+)", src)
APP_ORIGIN = m.group(1) if m else sys.exit("could not find iframe origin")

def http(url, method="GET", headers=None, body=None, binary=False):
    h = {"User-Agent": UA}; h.update(headers or {})
    req = urllib.request.Request(url, data=body, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
        return r.geturl(), r.headers.get("Content-Type", ""), data

def jpost(url, key, payload, token=None, path_suffix=""):
    h = {"Content-Type": "application/json", "apikey": key}
    if token: h["Authorization"] = f"Bearer {token}"
    try:
        _, _, d = http(url, "POST", h, json.dumps(payload).encode())
        return json.loads(d or b"{}")
    except urllib.error.HTTPError as e:
        print(f"  ! {url} -> {e.code} {e.read()[:200]!r}", file=sys.stderr)
        return None

def setup_session():
    print("signup (anonymous)...")
    s = jpost(f"{MAIN_URL}/auth/v1/signup", MAIN_KEY, {})
    if not s or "access_token" not in s: sys.exit("anonymous signup failed")
    access, refresh, uid = s["access_token"], s["refresh_token"], s["user"]["id"]

    try: ip = json.loads(http("https://api.ipify.org?format=json")[2]).get("ip", "")
    except Exception: ip = ""

    lb = jpost(f"{LB_URL}/rest/v1/rpc/get_leaderboard_data", LB_KEY, {"target_user_id": uid}, access)
    prof = (lb[0] if isinstance(lb, list) and lb else lb) or {}
    ident = {"id": prof.get("user_id") or uid, "name": prof.get("username") or "Guest"}

    if ip:
        print("link_guest_ip...")
        jpost(f"{MAIN_URL}/rest/v1/rpc/link_guest_ip", MAIN_KEY, {"p_ip": ip}, access)
    print("set_duck_identity...")
    jpost(f"{MAIN_URL}/rest/v1/rpc/set_duck_identity", MAIN_KEY,
          {"p_duck_user_id": ident["id"], "p_duck_username": ident["name"]}, access)

    r = jpost(f"{MAIN_URL}/auth/v1/token?grant_type=refresh_token", MAIN_KEY, {"refresh_token": refresh})
    if not r or "access_token" not in r: sys.exit("token refresh failed")
    return r["access_token"]

# ---------- crawler ----------
class Links(HTMLParser):
    def __init__(self): super().__init__(); self.urls = []
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        for k in ("src", "href", "data-src", "poster", "content"):
            v = a.get(k)
            if v and (k != "content" or v.startswith(("/", "./", "http"))): self.urls.append(v)
        if a.get("srcset"):
            self.urls += [p.strip().split()[0] for p in a["srcset"].split(",") if p.strip()]

ASSET_EXT = r"(?:js|mjs|css|json|wasm|data|mem|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp3|ogg|wav|mp4|webm|txt|map|bin|pck|unityweb|br|gz)"
STR_RE = re.compile(r"""["'`]((?:\.{0,2}/)?[\w\-./@%~+]+\.""" + ASSET_EXT + r""")(?:\?[^"'`\s]*)?["'`]""")
CSS_URL = re.compile(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)")
CSS_IMP = re.compile(r"@import\s+['\"]([^'\"]+)['\"]")

def local_path(url):
    p = urllib.parse.urlparse(url)
    path = p.path
    if path.endswith("/") or path == "": path += "index.html"
    path = path.lstrip("/")
    if p.query:
        stem, ext = os.path.splitext(path)
        path = f"{stem}__{hashlib.md5(p.query.encode()).hexdigest()[:8]}{ext}"
    return os.path.normpath(os.path.join(OUT, path))

def crawl(start_url, token):
    seen, manifest, q = set(), [], deque([start_url])
    def strip(u):  # never persist the token
        p = urllib.parse.urlparse(u)
        qs = [(k, v) for k, v in urllib.parse.parse_qsl(p.query) if k != "token"]
        return urllib.parse.urlunparse(p._replace(query=urllib.parse.urlencode(qs), fragment=""))
    while q and len(manifest) < MAX_FILES:
        url = q.popleft()
        key = strip(url)
        if key in seen: continue
        seen.add(key)
        try:
            final, ctype, data = http(url)
        except Exception as e:
            print(f"  skip {key}: {e}", file=sys.stderr); continue
        if not final.startswith(APP_ORIGIN): continue
        dest = local_path(strip(final) if urllib.parse.urlparse(final).path not in ("", "/") or not manifest else key)
        if not dest.startswith(OUT): continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if token.encode() in data:  # safety: don't commit a live token
            data = data.replace(token.encode(), b"__TOKEN__")
        open(dest, "wb").write(data)
        manifest.append({"url": key, "file": os.path.relpath(dest, ROOT), "type": ctype, "bytes": len(data)})
        print(f"  saved {key} ({len(data)} B)")

        text = None
        c = ctype.lower()
        if any(t in c for t in ("html", "javascript", "css", "json", "text")) or dest.endswith((".js", ".mjs", ".css", ".html", ".json")):
            text = data.decode("utf-8", "ignore")
        if text is None: continue
        found = []
        if "html" in c:
            lp = Links(); lp.feed(text); found += lp.urls
        found += CSS_URL.findall(text) + CSS_IMP.findall(text)
        if "html" not in c: found += STR_RE.findall(text)
        else: found += STR_RE.findall(text)
        for f in found:
            if f.startswith(("data:", "blob:", "javascript:", "mailto:", "#")): continue
            nu = urllib.parse.urljoin(final, f)
            if nu.startswith(APP_ORIGIN) and strip(nu) not in seen: q.append(nu)
    return manifest

if __name__ == "__main__":
    token = setup_session()
    start = f"{APP_ORIGIN}/?token={urllib.parse.quote(token)}&autostart=true"
    os.makedirs(OUT, exist_ok=True)
    manifest = crawl(start, token)
    json.dump({"origin": APP_ORIGIN, "files": manifest}, open(os.path.join(OUT, "_manifest.json"), "w"), indent=2)
    print(f"done: {len(manifest)} files -> ref/")
