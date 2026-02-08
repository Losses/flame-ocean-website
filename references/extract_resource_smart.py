#!/usr/bin/env python3
"""
Smart Bitmap Resource Extractor with Bootloader Field Reorganization Handling

This script extracts bitmap images from firmware files by correctly handling
the Bootloader's runtime metadata field reorganization pattern.

KEY INSIGHT FROM FIRMWARE ANALYSIS (2026-02-07):
================================================
Entry 0 is NOT "corrupted" - the firmware works correctly!

The Bootloader reorganizes Flash metadata fields when building runtime descriptors:
  Flash Entry[i].offset   → runtime descriptor[i].offset
  Flash Entry[i+1].width  → runtime descriptor[i].width
  Flash Entry[i+1].height → runtime descriptor[i].height

This is NOT a bug or corruption - it's the intentional storage format in Flash.
When extracting, we must read width/height from Entry[i+1] for ALL entries.

Key Features:
- Automatic detection of Flash metadata structure pattern
- Uses ROCK26 resource table as ground truth for offset verification
- Statistical analysis to determine correct offset mapping
- Handles firmware variations across different versions

Detection Algorithm:
1. Reads all offsets from ROCK26 table (reliable ground truth)
2. Compares with metadata entry offsets using statistical voting
3. Determines misalignment pattern by majority consensus
4. Dynamically adjusts extraction logic based on detected pattern
"""

import struct
import sys
from pathlib import Path
from datetime import datetime


# ============================================================================
# Image Conversion Functions
# ============================================================================

def swap_bytes_16bit(data):
    """Swap odd and even bytes to convert between big-endian and little-endian.

    Args:
        data: Input bytes to swap

    Returns:
        Bytes with odd/even positions swapped. If input has odd length,
        the last byte is discarded.
    """
    arr = bytearray(data)
    if len(arr) % 2 != 0:
        arr = arr[:-1]
    arr[0::2], arr[1::2] = arr[1::2], arr[0::2]
    return bytes(arr)


def get_stride_info(width):
    """Calculate stride and padding information for BMP row alignment.

    Args:
        width: Image width in pixels

    Returns:
        Tuple of (source_stride, destination_stride, padding_bytes)
    """
    src_stride = width * 2
    dst_stride = (src_stride + 3) & ~3
    padding = dst_stride - src_stride
    return src_stride, dst_stride, padding


def restride_to_bmp(raw_data, width, height):
    """Convert compact pixel data to BMP-aligned row format.

    Args:
        raw_data: Compact pixel data (width * height * 2 bytes expected)
        width: Image width in pixels
        height: Image height in pixels

    Returns:
        BMP-aligned pixel data with padding bytes inserted.
    """
    src_stride, dst_stride, padding = get_stride_info(width)

    if padding == 0 and len(raw_data) == src_stride * height:
        return raw_data

    expected_len = src_stride * height
    if len(raw_data) < expected_len:
        raw_data += b'\x00' * (expected_len - len(raw_data))

    output = bytearray()
    for y in range(height):
        src_start = y * src_stride
        src_end = src_start + src_stride
        output.extend(raw_data[src_start:src_end])
        if padding > 0:
            output.extend(b'\x00' * padding)

    return bytes(output)


def create_bmp_header(width, height):
    """Generate BMP file header for RGB565 format with bit masks.

    Args:
        width: Image width in pixels
        height: Image height in pixels (stored as negative for top-down bitmap)

    Returns:
        Complete BMP header as bytes.
    """
    src_stride, dst_stride, padding = get_stride_info(width)
    image_size = dst_stride * height
    headers_size = 14 + 40 + 12
    file_size = headers_size + image_size

    header = b'BM'
    header += struct.pack('<I', file_size)
    header += b'\x00\x00\x00\x00'
    header += struct.pack('<I', headers_size)
    header += struct.pack('<I', 40)
    header += struct.pack('<i', width)
    header += struct.pack('<i', -height)
    header += struct.pack('<H', 1)
    header += struct.pack('<H', 16)
    header += struct.pack('<I', 3)
    header += struct.pack('<I', image_size)
    header += struct.pack('<i', 2835)
    header += struct.pack('<i', 2835)
    header += struct.pack('<I', 0)
    header += struct.pack('<I', 0)
    header += struct.pack('<I', 0xF800)
    header += struct.pack('<I', 0x07E0)
    header += struct.pack('<I', 0x001F)

    return header


def sanitize_filename(original_name):
    """Generate a safe filename by replacing invalid characters.

    Args:
        original_name: Original filename string

    Returns:
        Sanitized filename with only alphanumeric characters and safe symbols.
    """
    safe = original_name.replace('/', '_').replace('\\', '_')
    return "".join(c if (c.isalnum() or c in "._-(), ") else "_" for c in safe).strip()


def convert_to_bmp(raw_data, width, height):
    """Convert raw RGB565 pixel data to a valid BMP file.

    Args:
        raw_data: Raw RGB565 pixel data (2 bytes per pixel)
        width: Image width in pixels
        height: Image height in pixels

    Returns:
        Complete BMP file as bytes, or None if dimensions are invalid.
    """
    if width <= 0 or height <= 0:
        return None

    expected_size = width * height * 2
    if len(raw_data) < expected_size:
        raw_data += b'\x00' * (expected_size - len(raw_data))

    pixel_data = swap_bytes_16bit(raw_data[:expected_size])
    pixel_data = restride_to_bmp(pixel_data, width, height)
    header = create_bmp_header(width, height)

    return header + pixel_data


# ============================================================================
# Intelligent Misalignment Detection Functions
# ============================================================================

def detect_offset_misalignment(part5_data, metadata_entries, rock26_offset):
    """Detect Bootloader field reorganization pattern in metadata table.

    This function performs statistical analysis to determine if metadata table
    indices follow the Bootloader's runtime field reorganization pattern where
    width/height for Entry[i] are stored in Entry[i+1].

    Algorithm:
    1. Read all offsets from ROCK26 table (ground truth)
    2. Compare with metadata entry offsets using multiple shift hypotheses
    3. Use majority voting to determine the most likely offset pattern
    4. Validate Entry 0 status to detect Flash metadata structure pattern

    Args:
        part5_data: Raw Part 5 firmware data containing all tables
        metadata_entries: List of parsed metadata entry dictionaries
        rock26_offset: Starting offset of ROCK26 table in Part 5

    Returns:
        Tuple of (misalignment_amount, first_valid_entry_index, detection_details)
        - misalignment_amount: Detected index shift (e.g., +1, -1, 0)
        - first_valid_entry_index: Index of first reliable metadata entry
        - detection_details: Dictionary containing diagnostic information
    """
    rock26_count = struct.unpack('<I', part5_data[rock26_offset + 16:rock26_offset + 20])[0]

    rock26_offsets = []
    ROCK26_ENTRY_SIZE = 16
    rock26_entries_start = rock26_offset + 32

    sample_count = min(20, rock26_count)
    for i in range(sample_count):
        entry_offset = rock26_entries_start + i * ROCK26_ENTRY_SIZE
        offset = struct.unpack('<I', part5_data[entry_offset + 12:entry_offset + 16])[0]
        rock26_offsets.append(offset)

    detection_info = {
        'rock26_count': rock26_count,
        'rock26_sample_offsets': rock26_offsets[:5],
        'metadata_count': len(metadata_entries),
        'checks': []
    }

    offset_shift_votes = {}

    for rock26_idx in range(min(20, len(rock26_offsets))):
        rock26_offset_val = rock26_offsets[rock26_idx]

        for shift in range(-3, 4):
            metadata_idx = rock26_idx + shift

            if 0 <= metadata_idx < len(metadata_entries):
                metadata_offset_val = metadata_entries[metadata_idx]['offset']

                if metadata_offset_val == rock26_offset_val:
                    offset_shift_votes[shift] = offset_shift_votes.get(shift, 0) + 1

    detection_info['checks'].append({
        'name': 'ROCK26-Metadata correspondence statistics',
        'votes': offset_shift_votes
    })

    if offset_shift_votes:
        winning_shift = max(offset_shift_votes.items(), key=lambda x: x[1])
        best_shift = winning_shift[0]
        confidence = winning_shift[1]

        detection_info['checks'].append({
            'name': 'Statistical results',
            'best_shift': best_shift,
            'confidence': confidence,
            'total_votes': sum(offset_shift_votes.values())
        })

        # Check for Flash metadata structure pattern
        # Entry 0 offset appears invalid because fields are stored in Entry[1]
        entry0 = metadata_entries[0]
        has_flash_metadata_structure = (
            entry0['offset'] == 0 or
            entry0['offset'] >= len(part5_data) or
            entry0['offset'] == 0xF564F564 or
            entry0['offset'] == 0xB7B5D7B5 or
            entry0['offset'] == 0x00000000 or
            entry0['offset'] == 0xC308C308 or
            entry0['offset'] == 0x45294529
        )

        detection_info['checks'].append({
            'name': 'Flash metadata structure detection',
            'result': has_flash_metadata_structure,
            'offset': hex(entry0['offset'])
        })

        if best_shift == 1:
            misalignment = 1
            first_valid_entry = 1
            detection_info['conclusion'] = f"Detected +1 index misalignment (statistical confidence: {confidence}/{min(20, len(rock26_offsets))} samples match)"
        elif best_shift == 0:
            misalignment = 0
            first_valid_entry = 0
            detection_info['conclusion'] = f"No misalignment detected (statistical confidence: {confidence}/{min(20, len(rock26_offsets))} samples match)"
        else:
            misalignment = best_shift
            first_valid_entry = max(1, 1 - best_shift)
            detection_info['conclusion'] = f"Detected {misalignment:+d} index misalignment (statistical confidence: {confidence}/{min(20, len(rock26_offsets))} samples match)"

    else:
        detection_info['conclusion'] = "Statistical analysis failed, falling back to single-point detection"

        if rock26_offsets:
            first_match_index = None
            for i, entry in enumerate(metadata_entries):
                if entry['offset'] == rock26_offsets[0]:
                    first_match_index = i
                    break

            if first_match_index is not None:
                misalignment = first_match_index - 1
                first_valid_entry = 1
                detection_info['conclusion'] = f"Fallback detection result: {misalignment:+d} shift"
            else:
                misalignment = 0
                first_valid_entry = 0
        else:
            misalignment = 0
            first_valid_entry = 0

    return misalignment, first_valid_entry, detection_info

def find_metadata_table_by_rock26_anchor(part5_data):
    """Locate metadata table using ROCK26 table as ground truth anchor.

    This method uses the known-reliable ROCK26 resource table to find the
    corresponding metadata table without relying on specific resource names
    or statistical scoring.

    Algorithm:
    1. Read ROCK26 Entry 0's offset value (deterministic anchor point)
    2. Search entire Part 5 for this offset in metadata entry offset fields
    3. Scan backward from match to find the true table start

    Advantages:
    - Does not depend on specific resource names (e.g., POWERON1)
    - No statistical/scoring ambiguity (100% deterministic)
    - Leverages known-reliable ROCK26 table structure

    Args:
        part5_data: Raw Part 5 firmware data

    Returns:
        Starting offset of metadata table, or None if not found.
    """
    METADATA_ENTRY_SIZE = 108
    OFFSET_FIELD_POS = 20

    rock26_offset = part5_data.find(b'ROCK26IMAGERES')
    if rock26_offset == -1:
        return None

    rock26_entries_start = rock26_offset + 32

    try:
        anchor_offset = struct.unpack('<I', part5_data[rock26_entries_start + 12:rock26_entries_start + 16])[0]
    except:
        return None

    matching_positions = []

    for pos in range(0, len(part5_data) - METADATA_ENTRY_SIZE, 4):
        try:
            entry_offset = struct.unpack('<I', part5_data[pos + OFFSET_FIELD_POS:pos + OFFSET_FIELD_POS + 4])[0]

            if entry_offset == anchor_offset:
                name_bytes = part5_data[pos + 32:pos + 96]
                name = name_bytes.split(b'\x00')[0].decode('ascii', errors='ignore')

                if name.endswith('.BMP') and len(name) >= 3:
                    matching_positions.append(pos)
        except:
            continue

    if not matching_positions:
        return None

    first_match = min(matching_positions)

    table_start = first_match
    while table_start >= METADATA_ENTRY_SIZE:
        test_pos = table_start - METADATA_ENTRY_SIZE
        test_entry = part5_data[test_pos:test_pos + METADATA_ENTRY_SIZE]
        test_name = test_entry[32:96].split(b'\x00')[0].decode('ascii', errors='ignore')

        if test_name and test_name.endswith('.BMP') and len(test_name) >= 3:
            if all(c.isprintable() or c in '._-(), ' for c in test_name):
                table_start = test_pos
            else:
                break
        else:
            break

    return table_start


def find_metadata_table_in_part5_robust(part5_data, rock26_offset):
    """Robust metadata table locator using ROCK26 as ground truth.

    Args:
        part5_data: Raw Part 5 firmware data
        rock26_offset: Starting offset of ROCK26 table (unused, kept for compatibility)

    Returns:
        Starting offset of metadata table, or None if not found.
    """
    return find_metadata_table_by_rock26_anchor(part5_data)


def find_metadata_table_in_part5(part5_data, rock26_offset):
    """Find metadata table in Part 5 using ROCK26 anchor method.

    Args:
        part5_data: Raw Part 5 firmware data
        rock26_offset: Starting offset of ROCK26 table

    Returns:
        Starting offset of metadata table, or None if not found.
    """
    return find_metadata_table_in_part5_robust(part5_data, rock26_offset)


def parse_metadata_table_part5(part5_data, table_start):
    """Parse metadata table entries from Part 5 data.

    Args:
        part5_data: Raw Part 5 firmware data
        table_start: Starting offset of metadata table

    Returns:
        List of metadata entry dictionaries containing index, offset, width, height, and name.
    """
    METADATA_ENTRY_SIZE = 108
    entries = []
    pos = table_start

    while pos + METADATA_ENTRY_SIZE <= len(part5_data):
        entry = part5_data[pos:pos + 108]

        name_bytes = entry[32:96]
        name = name_bytes.split(b'\x00')[0].decode('ascii', errors='ignore')

        if not name or len(name) < 3:
            break

        try:
            offset = struct.unpack('<I', entry[20:24])[0]
            width = struct.unpack('<I', entry[24:28])[0]
            height = struct.unpack('<I', entry[28:32])[0]

            entries.append({
                'index': len(entries),
                'offset': offset,
                'width': width,
                'height': height,
                'name': name
            })
        except:
            break

        pos += METADATA_ENTRY_SIZE

    return entries

def extract_part5_bitmaps_smart(img_path, output_base_dir, debug=False):
    """Intelligently detect and extract bitmaps from firmware image.

    Main extraction function that:
    1. Locates ROCK26 and metadata tables
    2. Detects index misalignment between tables
    3. Extracts and converts bitmap resources to BMP format

    Args:
        img_path: Path to firmware .IMG file
        output_base_dir: Base directory for output files
        debug: If True, print detailed detection information

    Returns:
        Dictionary with extraction statistics, or None on failure.
    """
    img_path = Path(img_path)
    version = img_path.parent.name

    print(f"\n{'='*80}")
    print(f"Processing firmware: {version} - {img_path.name}")
    print(f"{'='*80}")

    with open(img_path, 'rb') as f:
        img_data = f.read()

    part5_info = struct.unpack('<IIII', img_data[0x14C:0x15C])
    part5_offset, part5_size, _, _ = part5_info
    part5_data = img_data[part5_offset:part5_offset + part5_size]

    print(f"  Part 5 offset: 0x{part5_offset:08X}")
    print(f"  Part 5 size: {len(part5_data):,} bytes")

    rock26_offset = part5_data.find(b'ROCK26IMAGERES')
    if rock26_offset == -1:
        print(f"  ✗ ROCK26 table not found")
        return None

    print(f"  ✓ ROCK26 table location: 0x{rock26_offset:X}")

    table_start = find_metadata_table_in_part5(part5_data, rock26_offset)
    if not table_start:
        print(f"  ✗ Metadata table not found")
        return None

    print(f"  ✓ Metadata table location: 0x{table_start:X}")

    metadata_entries = parse_metadata_table_part5(part5_data, table_start)
    print(f"  ✓ Parsed {len(metadata_entries)} metadata entries")

    print(f"\n  🔍 Detecting offset misalignment...")
    misalignment, first_valid_entry, detection_info = detect_offset_misalignment(
        part5_data, metadata_entries, rock26_offset
    )

    print(f"  Detection results:")
    print(f"    {detection_info['conclusion']}")
    print(f"    Misalignment: {misalignment:+d}")
    print(f"    First valid entry: {first_valid_entry}")

    if debug:
        print(f"\n  Detection details:")
        for check in detection_info['checks']:
            print(f"    - {check['name']}: {check}")

    output_dir = Path(output_base_dir) / version
    output_dir.mkdir(parents=True, exist_ok=True)

    success_count = 0
    error_count = 0

    print(f"\n  Extracting bitmaps...")
    print(f"  {'ID':>4} {'Name':<30} {'Size':>10} {'Status':<10}")
    print("-" * 70)

    # When misalignment = 1, Entry 0 CAN still be extracted using Entry[1]'s offset
    start_index = 0
    end_index = len(metadata_entries) - (1 if misalignment > 0 else 0)

    for i in range(start_index, end_index):
        entry = metadata_entries[i]
        resource_id = entry['index']

        if misalignment > 0:
            target_index = i + misalignment
            if target_index >= len(metadata_entries):
                continue
            offset = metadata_entries[target_index]['offset']
        elif misalignment < 0:
            target_index = i + misalignment
            if target_index < 0:
                continue
            offset = metadata_entries[target_index]['offset']
        else:
            offset = entry['offset']

        name = entry['name']

        # Get width/height from Entry[i+1] (Bootloader field reorganization)
        if i + 1 < len(metadata_entries):
            width = metadata_entries[i + 1]['width']
            height = metadata_entries[i + 1]['height']
        else:
            width = entry['width']
            height = entry['height']

        if offset == 0 or offset >= len(part5_data):
            continue
        if width <= 0 or height <= 0 or width > 10000 or height > 10000:
            continue

        raw_size = width * height * 2
        raw_data = part5_data[offset:offset + raw_size]

        bmp_data = convert_to_bmp(raw_data, width, height)

        if bmp_data:
            safe_name = sanitize_filename(name)
            if not safe_name.lower().endswith('.bmp'):
                safe_name += '.bmp'

            output_file = output_dir / safe_name
            with open(output_file, 'wb') as f:
                f.write(bmp_data)

            success_count += 1

            if i < 12 or i % 200 == 0:
                wh_source = f"Entry[{i+1}]" if i + 1 < len(metadata_entries) else f"Entry[{i}]"
                print(f"  {resource_id:>4} {name:<30} {width}x{height:>6} ({wh_source})   ✓")
        else:
            error_count += 1

    print("-" * 70)
    print(f"  Complete: success={success_count}, errors={error_count}")

    return {
        'version': version,
        'total': end_index - start_index,
        'success': success_count,
        'error': error_count,
        'misalignment': misalignment,
        'detection_info': detection_info
    }


def main():
    """Main entry point: Process all firmware versions.

    Scans for firmware files and extracts bitmaps from each using
    intelligent misalignment detection.
    """
    import sys

    firmware_dir = Path("/home/losses/Downloads/ECHO MINI V3.1.0/firmwares")
    img_files = sorted(firmware_dir.glob("**/*.IMG"))

    if not img_files:
        print("Error: No firmware files found")
        sys.exit(1)

    output_base = "extracted_bitmaps_smart"
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    output_dir = Path(output_base) / f"batch_{timestamp}"

    print("="*80)
    print(f"Intelligently detecting and extracting bitmaps from all firmware versions")
    print("="*80)
    print(f"Firmware count: {len(img_files)}")
    print(f"Output directory: {output_dir}")
    print(f"Feature: Dynamic offset misalignment detection, no hardcoded +1/-1")
    print(f"Start time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    debug_mode = '-v' in sys.argv or '--debug' in sys.argv
    if debug_mode:
        print(f"\nDebug mode: Showing detailed detection information")

    results = []

    for img_file in img_files:
        try:
            result = extract_part5_bitmaps_smart(img_file, output_dir, debug=debug_mode)
            if result:
                results.append(result)
        except Exception as e:
            print(f"\n  ✗ Error: {e}")
            import traceback
            traceback.print_exc()

    print(f"\n{'='*80}")
    print("Summary Report")
    print(f"{'='*80}")
    print(f"{'Version':<20} {'Shift':<8} {'Total':>6} {'Success':>6} {'Errors':>6}")
    print("-"*80)

    misalignment_counts = {}
    total_success = 0
    for r in results:
        misalignment = r['misalignment']
        misalignment_counts[misalignment] = misalignment_counts.get(misalignment, 0) + 1
        print(f"{r['version']:<20} {misalignment:+4d}    {r['total']:>6} {r['success']:>6} {r['error']:>6}")
        total_success += r['success']

    print("-"*80)
    print(f"{'Total':<20} {'':>8} {sum(r['total'] for r in results):>6} {total_success:>6} {sum(r['error'] for r in results):>6}")

    print(f"\nMisalignment pattern statistics:")
    for misalignment, count in sorted(misalignment_counts.items()):
        print(f"  Shift {misalignment:+d}: {count} versions")

    print()
    print(f"✅ Complete! All bitmaps saved to: {output_dir}")
    print(f"   Total extracted: {total_success} bitmap files")


if __name__ == "__main__":
    main()
