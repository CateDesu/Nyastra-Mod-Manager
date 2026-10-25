import json
import os
import subprocess
import time
from html.parser import HTMLParser
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        fp.close()
        raise ValueError("Preview redirects are not allowed")


preview_opener = build_opener(NoRedirects())


def preview_request(url, host):
    origin = {
        "github.com": "https://github.com",
        "opengraph.githubassets.com": "https://opengraph.githubassets.com",
    }[host]
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != host
        or parsed.port not in (None, 443)
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ValueError("Untrusted GitHub preview URL")
    target = origin + (parsed.path or "/")
    if parsed.query:
        target += "?" + parsed.query
    return Request(target, headers={"User-Agent": "GitHub-push-preview"})


class PreviewMetadata(HTMLParser):
    def __init__(self):
        super().__init__()
        self.image_url = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta" and attrs.get("property") == "og:image":
            self.image_url = attrs.get("content")


def fetch_preview(commit_url, attempts=4):
    for attempt in range(attempts):
        try:
            request = preview_request(commit_url, "github.com")
            with preview_opener.open(request, timeout=10) as response:
                metadata = PreviewMetadata()
                metadata.feed(response.read(512 * 1024).decode("utf-8", errors="replace"))
            if not metadata.image_url:
                raise ValueError("Missing preview metadata")
            image_request = preview_request(
                urljoin(commit_url, metadata.image_url), "opengraph.githubassets.com"
            )
            with preview_opener.open(image_request, timeout=10) as response:
                image = response.read(5 * 1024 * 1024 + 1)
            if (
                not image.startswith(b"\x89PNG\r\n\x1a\n")
                or not image.endswith(b"\x00\x00\x00\x00IEND\xaeB\x60\x82")
                or len(image) > 5 * 1024 * 1024
            ):
                raise ValueError("Invalid preview image")
            return image
        except (OSError, ValueError, HTTPException) as error:
            if isinstance(error, HTTPError):
                error.close()
            if attempt + 1 < attempts:
                time.sleep(2 ** (attempt + 1))
    print("::warning::GitHub preview unavailable after retries; sending the commit link.")
    return None


def shorten(text, limit):
    return text if len(text) <= limit else text[:limit - 1] + "…"


def notification(repo, ref, actor, message, commit_url, has_image):
    message = message.strip()
    header = f"📦 Push to **{repo}** ({ref}) by {actor}\n\n"
    # Suppress the automatic unfurl when the original card is attached explicitly.
    link = f"<{commit_url}>" if has_image else commit_url
    content = header + shorten(message, 2000 - len(header) - len(link) - 1) + "\n" + link
    payload = {"content": content, "username": repo.rsplit("/", 1)[-1]}
    if has_image:
        payload["embeds"] = [{
            "title": shorten(message.splitlines()[0] if message.strip() else repo, 256),
            "url": commit_url,
            "image": {"url": "attachment://discord-preview.png"},
        }]
        payload["attachments"] = [{"id": 0, "filename": "discord-preview.png"}]
    return payload


def prepare(env, output):
    repo = env["REPO"]
    sha = env["COMMIT_SHA"]
    commit_url = env.get("COMMIT_URL") or f"https://github.com/{repo}/commit/{sha}"
    message = env.get("COMMIT_MSG") or subprocess.check_output(
        ["git", "show", "-s", "--format=%B", sha], text=True
    ).strip()
    image_path = output / "discord-preview.png"
    image_path.unlink(missing_ok=True)
    image = fetch_preview(commit_url)
    if image is not None:
        image_path.write_bytes(image)
    payload = notification(repo, env["REF"], env["ACTOR"], message, commit_url, image is not None)
    (output / "discord-notification.json").write_text(json.dumps(payload), encoding="utf-8")


if __name__ == "__main__":
    prepare(os.environ, Path(os.environ["RUNNER_TEMP"]))
