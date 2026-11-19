import json, os, re, subprocess, sys

BASE = os.path.expanduser("~/workspace/cloneus-shop-api")
TEAM = "team_5OmI00Pm2DbMxC9KAMGSrMsO"
PROJECT_ID = "prj_yFKQoZsEHPXx3MGD63siz7Kc90cK"
NAME = "cloneus-shop-api-hung"
# Giới hạn 1 argument của Linux (MAX_ARG_STRLEN). JSON args vượt quá là
# exec báo "Argument list too long" — xem ghi chú minify bên dưới.
ARG_LIMIT = 131072

# Minify khi deploy (chỉ đổi payload upload, KHÔNG sửa file nguồn):
# - Trước bản này payload JSON ~173KB > giới hạn 128KB/argument nên deploy
#   lỗi E2BIG ("Argument list too long"). Minify + JSON compact
#   (ensure_ascii=False, separators gọn) đưa payload xuống dưới giới hạn.
# - api/register.js KHÔNG minify (theo yêu cầu: không đụng tới file này).


def terser(code, module=False):
    # --mangle: rút ngắn tên biến cục bộ (tên top-level như handler/buyNow
    # được giữ nguyên theo mặc định toplevel:false, nên onclick trong HTML
    # và export default không bị ảnh hưởng).
    cmd = ["npx", "-y", "terser", "--compress", "--mangle"]
    if module:
        cmd.append("--module")
    r = subprocess.run(cmd, input=code, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("terser failed: " + (r.stderr or "").strip()[:500])
    return r.stdout


def minify_css_block(m):
    css = m.group(1)
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    css = re.sub(r"\s+", " ", css)
    css = re.sub(r"\s*([{}:;,>])\s*", r"\1", css)
    return "<style>" + css.strip() + "</style>"


def minify_html(text):
    text = re.sub(r"<style>(.*?)</style>", minify_css_block, text, flags=re.S)
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    text = re.sub(r">\s+<", "><", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    # Minify từng khối <script> nội tuyến (không chứa </script> trong chuỗi).
    def min_script(m):
        return "<script>" + terser(m.group(1)).strip() + "</script>"
    text = re.sub(r"<script>(.*?)</script>", min_script, text, flags=re.S)
    return text


files = []
for root, dirs, names in os.walk(BASE):
    # Không deploy thư mục ẩn (ví dụ .staging-buy chứa code tham khảo, không phải endpoint live).
    dirs[:] = [d for d in dirs if not d.startswith(".")]
    for n in sorted(names):
        if n in (".env.example", "README.md", "deploy.py"):
            continue
        if n.startswith("."):
            continue
        p = os.path.join(root, n)
        rel = os.path.relpath(p, BASE)
        with open(p, "r", encoding="utf-8") as f:
            data = f.read()
        if rel.endswith(".html"):
            data = minify_html(data)
        elif rel.endswith(".js") and rel != "api/register.js":
            data = terser(data, module=True)
        files.append({"file": rel, "data": data, "encoding": "utf-8"})

print("files:", [f["file"] for f in files])

args = {
    "teamId": TEAM,
    "requestBody": {
        "name": NAME,
        "project": PROJECT_ID,
        "target": "production",
        "files": files,
        "projectSettings": {"framework": None},
    },
}
args_json = json.dumps(args, ensure_ascii=False, separators=(",", ":"))
print("args json bytes:", len(args_json.encode("utf-8")), "limit:", ARG_LIMIT)
if len(args_json.encode("utf-8")) > ARG_LIMIT:
    print("ERROR: payload vượt giới hạn 1 argument của Linux — cần giảm kích thước file "
          "trước khi deploy lại.", file=sys.stderr)
    sys.exit(2)

cmd = ["/opt/hatch/bin/vercel", "call-tool", "--name", "create_deployment",
       "--arguments-json", args_json]
r = subprocess.run(cmd, capture_output=True, text=True)
print(r.stdout[:6000])
print(r.stderr[:2000], file=sys.stderr)
