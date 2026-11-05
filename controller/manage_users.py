"""
Studio users. There is no sign-up page: accounts are made here, on the server.

With Docker (the normal way), from ~/raadio:
    docker compose exec controller python /app/controller/manage_users.py add alice
    docker compose exec controller python /app/controller/manage_users.py passwd alice
    docker compose exec controller python /app/controller/manage_users.py remove alice
    docker compose exec controller python /app/controller/manage_users.py list
    docker compose exec controller python /app/controller/manage_users.py role alice curator
    docker compose exec controller python /app/controller/manage_users.py role alice member

Curators also see the tier list and listener analytics in the studio.

Passwords are asked for (not typed on the command line, so they stay out of
your shell history). Changing a password logs that user out everywhere.
"""
import getpass
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import MIN_PASSWORD, Studio

REPO = Path(__file__).resolve().parent.parent


def data_dir():
    value = os.environ.get("DATA_DIR")
    if not value:                                   # running outside Docker: read .env
        env_file = REPO / ".env"
        if env_file.is_file():
            for line in env_file.read_text().splitlines():
                if line.strip().startswith("DATA_DIR="):
                    value = line.split("=", 1)[1].split(" #", 1)[0].strip().strip("\"'")
    path = Path(value or "data")
    return path if path.is_absolute() else REPO / path


def ask_password():
    while True:
        first = getpass.getpass(f"New password (at least {MIN_PASSWORD} characters): ")
        if len(first) < MIN_PASSWORD:
            print("Too short, try again.")
            continue
        if getpass.getpass("Same password again: ") != first:
            print("They don't match, try again.")
            continue
        return first


def main(argv):
    if len(argv) < 2 or argv[1] not in ("add", "passwd", "remove", "list", "role") \
            or (argv[1] == "role" and len(argv) != 4) \
            or (argv[1] not in ("list", "role") and len(argv) != 3):
        print(__doc__.strip())
        return 2

    studio = Studio(data_dir())
    cmd = argv[1]
    try:
        if cmd == "list":
            users = studio.list_users()
            if not users:
                print("No users yet. Add one with: manage_users.py add <name>")
            for u in users:
                print(f"{u['username']:<20} {u['role']}")
        elif cmd == "add":
            studio.add_user(argv[2], ask_password())
            print(f"Added {argv[2]}. They can log in on the website now.")
        elif cmd == "passwd":
            studio.set_password(argv[2], ask_password())
            print(f"Password changed for {argv[2]} (logged out on all devices).")
        elif cmd == "role":
            studio.set_role(argv[2], argv[3])
            print(f"{argv[2]} is now a {argv[3]}. They'll see the change next time they open the studio.")
        elif cmd == "remove":
            studio.remove_user(argv[2])
            print(f"Removed {argv[2]}. Their scheduled items stay on the calendar.")
    except (ValueError, LookupError) as e:
        print(f"Error: {e}")
        return 1
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
