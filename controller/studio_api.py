"""
Studio web API, mounted under /api by radio_controller.py.

    POST   /api/login            {username, password} -> {user, token, expiresAt}
    POST   /api/logout
    GET    /api/me
    PUT    /api/media?name=&kind= raw audio bytes in the body -> {id, name, duration}
    GET    /api/media/{id}/mp3   the audio converted to MP3 (for saving a recording)
    DELETE /api/media/{id}       an upload that was never scheduled
    GET    /api/schedule         the whole shared calendar
    POST   /api/schedule         {mediaId, name, startsAt, offsets, tz}
                                 offsets: [0, 2] = first airing + same time 2 days later
    PATCH  /api/schedule/{id}    any of {name, startsAt, offsets, tz}
    DELETE /api/schedule/{id}
    POST   /api/schedule/{id}/notes        {text}: any host can leave a note on an item
    DELETE /api/schedule/{id}/notes/{nid}  its author (or a curator) removes it
    GET    /api/upcoming         public: next air times for "Coming up"

Everything except /api/upcoming and /api/login needs "Authorization: Bearer <token>".
Users are created on the server with manage_users.py; there is no sign-up.
"""
import asyncio
import ipaddress
import json
import time

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response

from studio import Studio

LOGIN_MAX_FAILURES = 8          # per IP ...
LOGIN_WINDOW = 15 * 60          # ... within this many seconds


async def probe_audio(path):
    """Returns (is_audio, duration_seconds_or_None) using ffprobe."""
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_type:format=duration", "-of", "json", str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), 30)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return False, None
    try:
        info = json.loads(out or b"{}")
    except ValueError:
        return False, None
    is_audio = any(s.get("codec_type") == "audio" for s in info.get("streams", []))
    try:
        duration = round(float(info.get("format", {}).get("duration")), 1)
    except (TypeError, ValueError):
        duration = None                # browser recordings often don't say; that's fine
    return is_audio, duration


def masked(ip):
    """An address cut to its network (IPv4 /24, IPv6 /48) for the log: enough to see where
    login attempts come from, not who someone is."""
    try:
        net = ipaddress.ip_network(f"{ip}/{24 if ':' not in ip else 48}", strict=False)
        return str(net)
    except ValueError:
        return "?"


def build_router(studio: Studio, get_client_ip, max_upload_mb=50):
    router = APIRouter(prefix="/api")
    max_bytes = max_upload_mb * 1024 * 1024
    failures = {}                       # ip -> [timestamps of failed logins]

    def current_user(authorization: str = Header(default="")):
        token = authorization[7:].strip() if authorization[:7].lower() == "bearer " else ""
        user = studio.user_for_token(token)
        if not user:
            raise HTTPException(401, "Please log in again")
        user["token"] = token
        return user

    async def json_body(request: Request):
        try:
            data = await request.json()
        except ValueError:
            raise HTTPException(400, "Expected JSON") from None
        if not isinstance(data, dict):
            raise HTTPException(400, "Expected a JSON object")
        return data

    def run(fn, *args):
        """Studio errors -> HTTP errors the web player can show."""
        try:
            return fn(*args)
        except LookupError as e:
            raise HTTPException(404, str(e)) from None
        except PermissionError as e:
            raise HTTPException(403, str(e)) from None
        except ValueError as e:
            raise HTTPException(400, str(e)) from None

    # ---- auth ----------------------------------------------------------
    @router.post("/login")
    async def login(request: Request):
        data = await json_body(request)
        ip = get_client_ip(request)
        now = time.time()
        recent = [t for t in failures.get(ip, []) if now - t < LOGIN_WINDOW]
        if len(recent) >= LOGIN_MAX_FAILURES:
            raise HTTPException(429, "Too many tries. Wait 15 minutes and try again.")

        username = str(data.get("username", ""))[:64]
        password = str(data.get("password", ""))[:256]
        # scrypt takes ~50 ms of CPU: run it off the event loop so audio never stutters
        user = await asyncio.to_thread(studio.authenticate, username, password)
        if not user:
            recent.append(now)
            failures[ip] = recent
            print(f"Studio: failed login for '{username}' from {masked(ip)}")
            raise HTTPException(401, "Wrong username or password")

        failures.pop(ip, None)
        token, expires = studio.create_session(user["id"])
        print(f"Studio: {user['username']} logged in from {masked(ip)}")
        return {"user": user["username"], "role": user["role"], "token": token, "expiresAt": expires}

    @router.post("/logout")
    async def logout(user=Depends(current_user)):
        studio.end_session(user["token"])
        return {"ok": True}

    @router.get("/me")
    async def me(user=Depends(current_user)):
        return {"user": user["username"], "role": user["role"]}

    # ---- media ---------------------------------------------------------
    @router.put("/media")
    async def upload(request: Request, name: str = "", kind: str = "upload",
                     user=Depends(current_user)):
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > max_bytes:
            raise HTTPException(413, f"File is over {max_upload_mb} MB")

        media_id = studio.new_media_id()
        final = studio.media_path(media_id)
        part = final.with_name(media_id + ".part")
        size = 0
        try:
            with open(part, "wb") as f:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > max_bytes:
                        raise HTTPException(413, f"File is over {max_upload_mb} MB")
                    f.write(chunk)
            if size == 0:
                raise HTTPException(400, "The file is empty")
            is_audio, duration = await probe_audio(part)
            if not is_audio:
                raise HTTPException(415, "That file isn't audio the radio can play")
            part.rename(final)
        finally:
            part.unlink(missing_ok=True)

        media = studio.add_media(media_id, name, kind, size, duration, user["username"])
        print(f"Studio: {user['username']} uploaded '{media['name']}' "
              f"({size / 1048576:.1f} MB{f', {duration:.0f} s' if duration else ''})")
        return media

    @router.get("/media/{media_id}/mp3")
    async def media_mp3(media_id: str, user=Depends(current_user)):
        """The audio as an MP3 (96 kbps mono, ~0.7 MB a minute), for "Save copy"."""
        path = run(studio.media_path, media_id)
        if not path.is_file():
            raise HTTPException(404, "That audio isn't on the server any more")
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(path),
            "-vn", "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "96k",
            "-f", "mp3", "pipe:1",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), 120)
        except TimeoutError:
            proc.kill()
            await proc.wait()
            raise HTTPException(504, "Converting to MP3 took too long") from None
        if proc.returncode != 0 or not out:
            print(f"Studio: MP3 conversion failed for {media_id}: {err.decode(errors='replace')[-300:]}")
            raise HTTPException(500, "Couldn't convert to MP3")
        return Response(content=out, media_type="audio/mpeg",
                        headers={"Content-Disposition": f'attachment; filename="{media_id}.mp3"',
                                 "Cache-Control": "no-store"})

    @router.delete("/media/{media_id}")
    async def delete_media(media_id: str, user=Depends(current_user)):
        """Cancelled before scheduling: drop the upload right away."""
        run(studio.delete_media, media_id)
        return {"ok": True}

    # ---- schedule ------------------------------------------------------
    @router.get("/schedule")
    async def list_schedule(user=Depends(current_user)):
        return {"items": studio.list_schedules()}

    @router.post("/schedule")
    async def add_schedule(request: Request, user=Depends(current_user)):
        data = await json_body(request)
        item = run(studio.create_schedule, user["username"], data)
        print(f"Studio: {user['username']} scheduled '{item['name']}' for {item['nextAir']}")
        return item

    @router.patch("/schedule/{sid}")
    async def edit_schedule(sid: str, request: Request, user=Depends(current_user)):
        data = await json_body(request)
        return run(studio.update_schedule, sid, data)

    @router.delete("/schedule/{sid}")
    async def delete_schedule(sid: str, user=Depends(current_user)):
        run(studio.delete_schedule, sid)
        print(f"Studio: {user['username']} removed schedule {sid}")
        return {"ok": True}

    @router.post("/schedule/{sid}/notes")
    async def add_note(sid: str, request: Request, user=Depends(current_user)):
        data = await json_body(request)
        item = run(studio.add_schedule_note, sid, user["username"], data.get("text"))
        print(f"Studio: {user['username']} left a note on '{item['name']}'")
        return item

    @router.delete("/schedule/{sid}/notes/{note_id}")
    async def remove_note(sid: str, note_id: int, user=Depends(current_user)):
        return run(studio.remove_schedule_note, sid, note_id, user)

    @router.get("/upcoming")
    async def upcoming():
        return {"items": studio.upcoming(limit=5)}

    return router, current_user
