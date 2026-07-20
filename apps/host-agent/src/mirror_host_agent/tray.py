"""Windows tray status and local control policy UI."""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any

STATUS_LABELS = {
    "offline": "오프라인",
    "online": "온라인 · 연결 대기",
    "viewing": "원격 화면 공유 중",
    "controlling": "원격 제어 중",
    "locked": "긴급 잠금 · 재시작 필요",
}
STATUS_COLORS = {
    "offline": "#64748b",
    "online": "#2dd4bf",
    "viewing": "#60a5fa",
    "controlling": "#f59e0b",
    "locked": "#ef4444",
}


class TrayController:
    def __init__(
        self,
        *,
        control_enabled: bool,
        on_control_change: Callable[[bool], None],
        on_emergency_lock: Callable[[], None],
        on_restart: Callable[[], None] | None = None,
        on_open_folder: Callable[[], None] | None = None,
        on_wake_display: Callable[[], None] | None = None,
        on_quit: Callable[[], None] | None = None,
    ) -> None:
        self.status = "offline"
        self.control_enabled = control_enabled
        self.locked = False
        self._on_control_change = on_control_change
        self._on_emergency_lock = on_emergency_lock
        self._on_restart = on_restart
        self._on_open_folder = on_open_folder
        self._on_wake_display = on_wake_display
        self._on_quit = on_quit
        self._icon = None
        self._thread: threading.Thread | None = None

    def set_status(self, status: str) -> None:
        if status not in STATUS_LABELS:
            return
        self.status = "locked" if self.locked else status
        self._refresh()

    def toggle_control(self) -> None:
        if self.locked:
            return
        self.control_enabled = not self.control_enabled
        self._on_control_change(self.control_enabled)
        self._refresh()

    def emergency_lock(self) -> None:
        if self.locked:
            return
        self.locked = True
        self.control_enabled = False
        self.status = "locked"
        self._on_emergency_lock()
        self._refresh()

    def start(self) -> None:
        from PIL import Image, ImageDraw
        import pystray

        def make_image(color: str):
            image = Image.new("RGBA", (64, 64), "#0b0f14")
            draw = ImageDraw.Draw(image)
            draw.ellipse((10, 10, 54, 54), fill=color)
            draw.ellipse((24, 24, 40, 40), fill="#f8fafc")
            return image

        self._make_image = make_image
        menu_items: list[Any] = [
            pystray.MenuItem(lambda _item: self._title(), None, enabled=False),
        ]
        if self._on_restart is not None:
            menu_items.append(
                pystray.MenuItem(
                    "에이전트 재시작", lambda _icon, _item: self._on_restart()
                )
            )
        if self._on_open_folder is not None:
            menu_items.append(
                pystray.MenuItem(
                    "MirrorShare 폴더 열기",
                    lambda _icon, _item: self._on_open_folder(),
                )
            )
        if self._on_wake_display is not None:
            menu_items.append(
                pystray.MenuItem(
                    "화면 깨우기", lambda _icon, _item: self._on_wake_display()
                )
            )
        if menu_items and (
            self._on_restart is not None
            or self._on_open_folder is not None
            or self._on_wake_display is not None
        ):
            menu_items.append(pystray.Menu.SEPARATOR)
        menu_items.append(
            pystray.MenuItem(
                "원격 제어 허용",
                lambda _icon, _item: self.toggle_control(),
                checked=lambda _item: self.control_enabled,
                enabled=lambda _item: not self.locked,
            )
        )
        menu_items.append(
            pystray.MenuItem(
                "긴급 잠금 (재시작 전까지)",
                lambda _icon, _item: self.emergency_lock(),
                enabled=lambda _item: not self.locked,
            )
        )
        if self._on_quit is not None:
            menu_items.append(pystray.Menu.SEPARATOR)
            menu_items.append(
                pystray.MenuItem("종료", lambda _icon, _item: self._on_quit())
            )
        self._icon = pystray.Icon(
            "my-mirror-computer",
            make_image(STATUS_COLORS[self.status]),
            self._title(),
            menu=pystray.Menu(*menu_items),
        )
        self._thread = threading.Thread(
            target=self._icon.run,
            name="mirror-tray",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        if self._icon is not None:
            self._icon.stop()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        self._icon = None
        self._thread = None

    def _title(self) -> str:
        return f"My Mirror Computer · {STATUS_LABELS[self.status]}"

    def _refresh(self) -> None:
        if self._icon is None:
            return
        self._icon.title = self._title()
        self._icon.icon = self._make_image(STATUS_COLORS[self.status])
        self._icon.update_menu()
