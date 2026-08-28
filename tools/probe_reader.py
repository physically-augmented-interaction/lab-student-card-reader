"""List USB devices and check whether an RC-S380 is visible to nfcpy."""

from __future__ import annotations

import sys

RC_S380_VID = 0x054C
RC_S380_PIDS = {
    0x06C1: "RC-S380/S",
    0x06C3: "RC-S380/P",
}


def _format_usb_id(value: int) -> str:
    return f"0x{value:04x}"


def list_usb_devices() -> list[tuple[int, int, str | None, str | None]]:
    try:
        import usb1
    except ImportError:
        print("libusb1 is not installed. Run: uv sync", file=sys.stderr)
        return []

    devices: list[tuple[int, int, str | None, str | None]] = []
    with usb1.USBContext() as context:
        for device in context.getDeviceList(skip_on_error=True):
            manufacturer = None
            product = None
            try:
                manufacturer = device.getManufacturer()
            except Exception:
                pass
            try:
                product = device.getProduct()
            except Exception:
                pass
            devices.append(
                (
                    device.getVendorID(),
                    device.getProductID(),
                    manufacturer,
                    product,
                )
            )
    return devices


def probe_nfcpy() -> None:
    import nfc

    print("nfcpy probe: python -m nfc")
    try:
        clf = nfc.ContactlessFrontend("usb")
    except IOError as exc:
        print(f"nfcpy did not open a USB reader: {exc}")
        print("Connect RC-S380 and retry. If macOS still hides it, unplug/replug after closing other NFC apps.")
        return

    print(f"opened: {clf}")
    clf.close()


def main() -> int:
    print("USB devices")
    found_s380 = False
    devices = list_usb_devices()
    if not devices:
        print("  (none listed)")
    for vid, pid, manufacturer, product in devices:
        label = ""
        if vid == RC_S380_VID and pid in RC_S380_PIDS:
            found_s380 = True
            label = f"  <- {RC_S380_PIDS[pid]}"
        manuf = manufacturer or "?"
        prod = product or "?"
        print(f"  {manuf} {prod} vid={_format_usb_id(vid)} pid={_format_usb_id(pid)}{label}")

    print()
    if found_s380:
        print("RC-S380 USB device is visible.")
    else:
        print("RC-S380 is not visible (VID 0x054c / PID 0x06c1 or 0x06c3).")
        print("Plug it in directly or via a data-capable USB hub, then rerun:")
        print("  uv run python -m tools.probe_reader")

    print()
    probe_nfcpy()
    return 0 if found_s380 else 2


if __name__ == "__main__":
    raise SystemExit(main())
