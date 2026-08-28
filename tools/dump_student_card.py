"""Dump FeliCa student-card systems and unencrypted services via RC-S380.

This lab's first dumped card exposed:
  system code 0x8277
  service code 0x010B  (random read-only without key)
  block 0 ASCII like 002AE19051030000
  student number AE19051 (skip leading 00 / 2 and trailing 03 / padding)

This script never authenticates keyed services. It only:
1. lists system codes
2. walks Search Service Code
3. Read Without Encryption on unprotected services
4. prints ASCII / Shift_JIS candidates, especially 0xFE00 / 0x1A8B
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import nfc
from nfc.tag import TagCommandError
from nfc.tag.tt3 import BlockCode, ServiceCode, Type3Tag

CANDIDATE_SYSTEM = 0x8277
CANDIDATE_SERVICE = 0x010B
FALLBACK_SYSTEM = 0xFE00
FALLBACK_SERVICE = 0x1A8B
UNENCRYPTED_ATTRS = {0b001001, 0b001011, 0b001101, 0b001111, 0b010001, 0b010011, 0b010101, 0b010111}


def hexlify(data: bytes | bytearray) -> str:
    return bytes(data).hex().upper()


def printable(data: bytes, encoding: str = "ascii") -> str:
    text = data.decode(encoding, errors="replace")
    return "".join(ch if 32 <= ord(ch) <= 126 else "." for ch in text)


def service_info(code: int) -> dict[str, Any]:
    sc = ServiceCode.unpack(struct.pack("<H", code))
    return {
        "code": f"0x{code:04X}",
        "number": sc.number,
        "attribute": sc.attribute,
        "attribute_name": str(sc),
        "unencrypted": sc.attribute in UNENCRYPTED_ATTRS,
    }


def request_system_codes(tag: Type3Tag) -> list[int]:
    systems: list[int] = []
    try:
        rsp = tag.send_cmd_recv_rsp(0x0C, b"", timeout=0.3, check_status=False)
    except TagCommandError as exc:
        print(f"Request System Code failed: {exc}")
        rsp = b""
    if rsp:
        count = rsp[0]
        raw = rsp[1:]
        for i in range(count):
            offset = 2 * i
            if offset + 1 >= len(raw):
                break
            systems.append((raw[offset] << 8) | raw[offset + 1])
    if not systems:
        for system in (CANDIDATE_SYSTEM, 0xFFFF, 0x12FC, 0x0003, 0x88B4):
            try:
                polled = tag.polling(system, request_code=1)
            except Exception:
                continue
            if len(polled) >= 3:
                extra = polled[2]
                systems.append((extra[0] << 8) | extra[1])
            elif system != 0xFFFF:
                systems.append(system)
    unique: list[int] = []
    for system in systems:
        if system not in unique:
            unique.append(system)
    for extra in (CANDIDATE_SYSTEM, FALLBACK_SYSTEM):
        if extra not in unique:
            unique.append(extra)
    return unique


def search_service_codes(tag: Type3Tag) -> list[int]:
    found: list[int] = []
    index = 0
    while index < 0x10000:
        payload = struct.pack("<H", index)
        try:
            rsp = tag.send_cmd_recv_rsp(0x0A, payload, timeout=0.15, check_status=False)
        except TagCommandError:
            break
        if len(rsp) < 2:
            break
        code = rsp[0] | (rsp[1] << 8)
        if code == 0xFFFF:
            break
        if code not in found:
            found.append(code)
            info = service_info(code)
            print(f"  service {info['code']} {info['attribute_name']}")
        if len(rsp) >= 4:
            area_end = rsp[2] | (rsp[3] << 8)
            print(f"    area end 0x{area_end:04X}")
        index += 1
    for extra in (CANDIDATE_SERVICE, FALLBACK_SERVICE):
        if extra in found:
            continue
        packed = struct.pack("<H", extra)
        try:
            rsp = tag.send_cmd_recv_rsp(0x02, b"" + packed, timeout=0.15, check_status=False)
        except TagCommandError:
            rsp = b""
        if len(rsp) >= 3 and rsp[0] >= 1:
            key = rsp[1] | (rsp[2] << 8)
            if key != 0xFFFF:
                found.append(extra)
                print(f"  candidate service 0x{extra:04X} is present")
    return found


def read_blocks(tag: Type3Tag, service_code: int, max_blocks: int) -> list[dict[str, Any]]:
    sc = ServiceCode.unpack(struct.pack("<H", service_code))
    blocks: list[dict[str, Any]] = []
    for index in range(max_blocks):
        try:
            data = bytes(tag.read_without_encryption([sc], [BlockCode(index)]))
        except TagCommandError as exc:
            if index == 0:
                print(f"    block 0 unreadable: {exc}")
            break
        item = {
            "index": index,
            "hex": hexlify(data),
            "ascii": printable(data, "ascii"),
            "shift_jis": printable(data, "cp932"),
        }
        blocks.append(item)
        print(f"    {index:02d}: {item['hex']} |{item['ascii']}|")
    return blocks


def extract_student_id_candidates(block0: bytes) -> list[str]:
    ascii_text = "".join(chr(b) if 32 <= b <= 126 else " " for b in block0)
    compact = " ".join(ascii_text.split())
    candidates: list[str] = []
    if compact:
        candidates.append(compact)
    # Observed layout: 00 2 AE19051 03 0000
    sliced = ascii_text[3:10].strip()
    if sliced and sliced not in candidates:
        candidates.append(sliced)
    stripped = ascii_text.strip("0").strip()
    if stripped and stripped not in candidates:
        candidates.append(stripped)
    return candidates


def dump_tag(tag: Type3Tag, max_blocks: int) -> dict[str, Any]:
    result: dict[str, Any] = {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "idm": hexlify(tag.idm),
        "pmm": hexlify(tag.pmm),
        "first_system": f"0x{tag.sys:04X}" if getattr(tag, "sys", None) is not None else None,
        "systems": [],
    }
    print(f"IDm={result['idm']} PMm={result['pmm']} first_system={result['first_system']}")
    systems = request_system_codes(tag)
    print("systems: " + ", ".join(f"0x{s:04X}" for s in systems))

    for system in systems:
        print()
        print(f"== system 0x{system:04X} ==")
        system_dump: dict[str, Any] = {"code": f"0x{system:04X}", "services": []}
        try:
            polled = tag.polling(system, request_code=1)
            tag.idm = polled[0]
            tag.pmm = polled[1]
            extra = polled[2] if len(polled) >= 3 else b""
            print(f"  poll IDm={hexlify(tag.idm)} PMm={hexlify(tag.pmm)} extra={hexlify(extra)}")
        except Exception as exc:
            print(f"  polling failed: {exc}")
            result["systems"].append(system_dump)
            continue

        for code in search_service_codes(tag):
            service = service_info(code)
            if not service["unencrypted"]:
                service["blocks"] = []
                service["skipped"] = "keyed-or-area"
                system_dump["services"].append(service)
                continue
            print(f"  dump unencrypted {service['code']}")
            blocks = read_blocks(tag, code, max_blocks)
            service["blocks"] = blocks
            if code in {CANDIDATE_SERVICE, FALLBACK_SERVICE} and blocks:
                service["student_id_candidates"] = extract_student_id_candidates(
                    bytes.fromhex(blocks[0]["hex"])
                )
                print(f"    student_id candidates: {service['student_id_candidates']}")
            system_dump["services"].append(service)
        result["systems"].append(system_dump)
    return result


def connected(tag: nfc.tag.Tag, output_dir: Path, max_blocks: int) -> bool:
    print(tag)
    if not isinstance(tag, Type3Tag):
        print(f"not a FeliCa/Type3 tag: {type(tag)}")
        return True
    dump = dump_tag(tag, max_blocks=max_blocks)
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{dump['idm']}-{int(time.time())}.json"
    path.write_text(json.dumps(dump, ensure_ascii=False, indent=2), encoding="utf-8")
    print()
    print(f"wrote {path}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Dump unencrypted FeliCa student-card services via RC-S380")
    parser.add_argument("--device", default="usb", help="nfcpy device path, default usb")
    parser.add_argument("--output-dir", default="dumps", type=Path)
    parser.add_argument("--max-blocks", default=8, type=int)
    args = parser.parse_args()

    print("Hold the student card on RC-S380. Ctrl+C to stop.")
    try:
        clf = nfc.ContactlessFrontend(args.device)
    except IOError as exc:
        print(f"failed to open reader ({args.device}): {exc}", file=sys.stderr)
        print("Run: uv run python -m tools.probe_reader", file=sys.stderr)
        return 2

    try:
        clf.connect(rdwr={"on-connect": lambda tag: connected(tag, args.output_dir, args.max_blocks)})
    except KeyboardInterrupt:
        print()
        print("stopped")
    finally:
        clf.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
