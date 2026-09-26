"""Read-only probe for DD1 FocusElement owners and virtual tables."""

from __future__ import annotations

import argparse
import ctypes
import struct
from ctypes import wintypes


PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
LIST_MODULES_ALL = 0x03

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
psapi = ctypes.WinDLL("psapi", use_last_error=True)

kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.ReadProcessMemory.argtypes = [
    wintypes.HANDLE,
    wintypes.LPCVOID,
    wintypes.LPVOID,
    ctypes.c_size_t,
    ctypes.POINTER(ctypes.c_size_t),
]
kernel32.ReadProcessMemory.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
psapi.EnumProcessModulesEx.argtypes = [
    wintypes.HANDLE,
    ctypes.POINTER(wintypes.HMODULE),
    wintypes.DWORD,
    ctypes.POINTER(wintypes.DWORD),
    wintypes.DWORD,
]
psapi.EnumProcessModulesEx.restype = wintypes.BOOL


def read(handle: int, address: int, size: int) -> bytes:
    buffer = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t()
    if not kernel32.ReadProcessMemory(handle, address, buffer, size, ctypes.byref(got)):
        raise OSError(ctypes.get_last_error(), f"ReadProcessMemory 0x{address:x}")
    return buffer.raw[: got.value]


def u64(handle: int, address: int) -> int:
    return struct.unpack("<Q", read(handle, address, 8))[0]


def module_base(handle: int) -> int:
    modules = (wintypes.HMODULE * 1024)()
    needed = wintypes.DWORD()
    if not psapi.EnumProcessModulesEx(
        handle, modules, ctypes.sizeof(modules), ctypes.byref(needed), LIST_MODULES_ALL
    ):
        raise OSError(ctypes.get_last_error(), "EnumProcessModulesEx")
    if needed.value < ctypes.sizeof(wintypes.HMODULE):
        raise RuntimeError("No process modules returned")
    return ctypes.cast(modules[0], ctypes.c_void_p).value or 0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pid", type=int)
    parser.add_argument("--first-id", type=lambda value: int(value, 0), default=0x717374)
    parser.add_argument("--count", type=int, default=7)
    args = parser.parse_args()

    handle = kernel32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, args.pid)
    if not handle:
        raise OSError(ctypes.get_last_error(), "OpenProcess")
    try:
        base = module_base(handle)
        begin = u64(handle, base + 0x2C27128)
        end = u64(handle, base + 0x2C27130)
        stride = 0x108
        total = min((end - begin) // stride, 4096)
        print(f"pid={args.pid} base=0x{base:x} focus=[0x{begin:x},0x{end:x}) n={total}")
        for index in range(total):
            element = begin + index * stride
            element_id = u64(handle, element)
            if not args.first_id <= element_id < args.first_id + args.count:
                continue
            element_bytes = read(handle, element, stride)
            owner = struct.unpack_from("<Q", element_bytes, 8)[0]
            callback_index = struct.unpack_from("<i", element_bytes, 0x38)[0]
            qwords = struct.unpack(f"<{stride // 8}Q", element_bytes)
            pointers = []
            for offset, value in enumerate(qwords):
                if base <= value < base + 0x2FAE000:
                    pointers.append((offset * 8, f"exe+0x{value-base:x}"))
                elif 0x10000 < value < 0x0000800000000000:
                    pointers.append((offset * 8, f"0x{value:x}"))
            print(
                f"id=0x{element_id:x} elem=0x{element:x} owner_tag=0x{owner:x} "
                f"callback_index={callback_index}"
            )
            print("  element_qwords=" + ",".join(f"+0x{offset:x}:{value}" for offset, value in pointers))
            for vft_offset in (0x30, 0x78):
                vft = struct.unpack_from("<Q", element_bytes, vft_offset)[0]
                if not base <= vft < base + 0x2FAE000:
                    continue
                entries = struct.unpack("<32Q", read(handle, vft, 32 * 8))
                rendered = [
                    f"0x{value-base:x}" if base <= value < base + 0x2FAE000 else f"0x{value:x}"
                    for value in entries
                ]
                print(f"  table+0x{vft_offset:x}=exe+0x{vft-base:x}:" + ",".join(rendered))
            for candidate_offset in (0x40, 0x48, 0x80):
                candidate = struct.unpack_from("<Q", element_bytes, candidate_offset)[0]
                try:
                    object_bytes = read(handle, candidate, 0x100)
                except OSError:
                    continue
                object_qwords = struct.unpack("<32Q", object_bytes)
                interesting = []
                for qword_offset, value in enumerate(object_qwords):
                    if base <= value < base + 0x2FAE000:
                        interesting.append(f"+0x{qword_offset*8:x}:exe+0x{value-base:x}")
                    elif value < 0x10000:
                        interesting.append(f"+0x{qword_offset*8:x}:{value}")
                print(
                    f"  ptr+0x{candidate_offset:x}=0x{candidate:x} "
                    + ",".join(interesting[:24])
                )
                candidate_vft = object_qwords[0]
                if base <= candidate_vft < base + 0x2FAE000:
                    entries = struct.unpack("<12Q", read(handle, candidate_vft, 12 * 8))
                    rendered = [
                        f"0x{value-base:x}" if base <= value < base + 0x2FAE000 else f"0x{value:x}"
                        for value in entries
                    ]
                    print(
                        f"    vft=exe+0x{candidate_vft-base:x}:" + ",".join(rendered)
                    )
    finally:
        kernel32.CloseHandle(handle)


if __name__ == "__main__":
    main()
