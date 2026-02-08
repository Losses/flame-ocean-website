#!/usr/bin/env python3
"""
Universal Font Extractor - Heuristic Offset Table Search

This script extracts font data from firmware images using sophisticated
heuristic algorithms to locate font tables without hard-coded addresses.

Key Features:
- Automatic detection of font base addresses using pattern recognition
- Support for both SMALL (32-byte stride) and LARGE (33-byte stride) font tables
- Comprehensive Unicode range coverage with customizable subsets
- Validation and confidence scoring for detected addresses
- Export to monochrome BMP format for easy visualization

Detection Methods:
1. SMALL_BASE: Derived from config bytes at 0x78-0x7B (100% reliable)
2. LARGE_BASE: Heuristic search using footer signature analysis and grid alignment
3. LOOKUP_TABLE: Fixed at 0x080000 (verified constant across versions)

Font Format:
- V8 encoding with variable bit/byte swapping controlled by lookup table
- 15x16 pixel monochrome bitmaps
- Supports full Unicode range via separate SMALL and LARGE tables
"""


import struct
import os
import argparse


class FirmwareAnalyzer:
    """Analyzes firmware images to detect font table locations.

    Uses heuristic algorithms to locate font data without relying on
    hard-coded addresses. Supports various firmware versions through
    pattern recognition and statistical analysis.
    """

    def __init__(self, firmware_path):
        """Initialize analyzer with firmware image.

        Args:
            firmware_path: Path to firmware .IMG file
        """
        with open(firmware_path, 'rb') as f:
            self.firmware = f.read()
        self.firmware_path = firmware_path

    def get_firmware_partition(self):
        """Read part_2_firmware_b partition information.

        The font data is located in this partition. Reads partition table
        entry at offset 0x80.

        Returns:
            Dictionary with 'offset' and 'size' of the partition.
        """
        chunk = self.firmware[0x80:0x80+16]
        offset, size, next_offset, _ = struct.unpack('<IIII', chunk)
        return {'offset': offset, 'size': size}

    def detect_small_base(self):
        """Detect SMALL_BASE address from configuration bytes.

        This method is 100% reliable as it reads from fixed config locations.

        Returns:
            Base address of SMALL font table.
        """
        config_78 = struct.unpack('<H', self.firmware[0x78:0x7A])[0]
        config_7A = struct.unpack('<H', self.firmware[0x7A:0x7C])[0]
        small_base = (config_7A << 16) | config_78
        return small_base

    def _score_window(self, window_start, window_end, FOOTER_SIGNATURES, LARGE_STRIDE, base_alignment=None):
        """Score a memory window for likelihood of containing font data.

        Scoring Criteria:
        1. Scan at 33-byte stride (font entry structure)
        2. Find longest consecutive sequence with valid footer signatures
        3. Immediately break on invalid values (0x00, 0xFF)
        4. Allow tolerance for minor footer anomalies (max 5 consecutive)
        5. Score = sequence length
        6. Return starting address of best sequence

        Args:
            window_start: Start of memory region to scan
            window_end: End of memory region to scan
            FOOTER_SIGNATURES: Set of valid footer byte values
            LARGE_STRIDE: Font entry stride (33 bytes)
            base_alignment: Required grid alignment (optional)

        Returns:
            Tuple of (max_sequence_length, sequence_start_address)
        """
        INVALID_VALUES = {0x00, 0xFF}

        max_sequence_length = 0
        max_sequence_start = window_start

        current_length = 0
        current_start = window_start
        consecutive_anomalies = 0
        max_anomalies = 5

        for offset in range(0, window_end - window_start, LARGE_STRIDE):
            addr = window_start + offset

            if addr + 32 >= len(self.firmware):
                break

            if base_alignment is not None:
                if addr % LARGE_STRIDE != base_alignment:
                    continue

            byte_32 = self.firmware[addr + 32]

            if byte_32 in INVALID_VALUES:
                if current_length > max_sequence_length:
                    max_sequence_length = current_length
                    max_sequence_start = current_start
                current_length = 0
                consecutive_anomalies = 0
            elif byte_32 in FOOTER_SIGNATURES:
                if current_length == 0:
                    current_start = addr
                current_length += 1
                consecutive_anomalies = 0
            else:
                consecutive_anomalies += 1

                if consecutive_anomalies <= max_anomalies:
                    if current_length == 0:
                        current_start = addr
                    current_length += 1
                else:
                    if current_length > max_sequence_length:
                        max_sequence_length = current_length
                        max_sequence_start = current_start

                    current_length = 0
                    consecutive_anomalies = 0

        if current_length > max_sequence_length:
            max_sequence_length = current_length
            max_sequence_start = current_start

        return max_sequence_length, max_sequence_start

    def search_offset_table(self):
        """Heuristically search for large font offset table.

        Uses windowed interval scoring method with progressive refinement.
        Employs footer signature analysis and grid alignment for accuracy.

        Returns:
            Detected base address of LARGE font table, or None if not found.
        """
        LARGE_STRIDE = 33
        FOOTER_SIGNATURES = {0x90, 0x8F, 0x89, 0x8B, 0x8D, 0x8E, 0x8C}

        partition = self.get_firmware_partition()
        search_start = partition['offset']
        search_end = partition['offset'] + partition['size']

        print(f"  Searching LARGE_BASE (window interval scoring)...")
        print(f"  Partition: part_2_firmware_b (0x{search_start:08X} - 0x{search_end:08X})")
        print(f"  Signature set: {sorted(FOOTER_SIGNATURES)}")

        window_size = 20902 * LARGE_STRIDE

        current_stride = window_size // 2
        min_stride = 100

        current_regions = [{'start': search_start, 'end': search_end}]

        iteration = 0
        best_addr = None
        best_score = -1
        base_alignment = None

        while current_stride > min_stride and current_regions:
            iteration += 1
            print(f"\n  Round {iteration} scan (stride: {current_stride} bytes)...")

            if base_alignment is not None:
                print(f"    Using grid alignment: addr % 33 = {base_alignment}")

            region_results = []

            for region in current_regions:
                for window_start in range(region['start'], region['end'], current_stride):
                    window_end = min(window_start + window_size, len(self.firmware))

                    score, first_addr = self._score_window(
                        window_start, window_end, FOOTER_SIGNATURES, LARGE_STRIDE, base_alignment
                    )

                    if score > best_score:
                        best_score = score
                        best_addr = first_addr

                    region_results.append({
                        'window_start': window_start,
                        'score': score,
                        'first_addr': first_addr
                    })

            region_results.sort(key=lambda x: x['score'], reverse=True)
            top_windows = region_results[:5]

            print(f"    Found {len(region_results)} windows, keeping top 5")
            for i, win in enumerate(top_windows[:3]):
                print(f"    [{i}] Window start:0x{win['window_start']:06X}, First addr:0x{win['first_addr']:06X}, Score:{win['score']:.1f}")

            if base_alignment is None and top_windows:
                best_first_addr = top_windows[0]['first_addr']
                base_alignment = best_first_addr % LARGE_STRIDE
                print(f"    Determined grid alignment: 0x{best_first_addr:06X} % {LARGE_STRIDE} = {base_alignment}")

            next_stride = max(min_stride, current_stride // 2)
            current_regions = []

            for win in top_windows:
                first_addr = win['first_addr']

                chars_extend = (current_stride // LARGE_STRIDE) + 1

                region_start = first_addr - chars_extend * LARGE_STRIDE
                region_end = first_addr + chars_extend * LARGE_STRIDE

                region_start = max(search_start, region_start)
                region_end = min(search_end, region_end)

                current_regions.append({'start': region_start, 'end': region_end})

            current_stride = next_stride

        print(f"\n  ✅ Best candidate: 0x{best_addr:08X}")
        print(f"  Score: {best_score}")

        return best_addr

    def _quick_footer_check(self, large_base, preferred_footer=0x90):
        """Quick footer verification check (only checks last byte of first 3 characters).

        Args:
            large_base: Suspected LARGE font table base address
            preferred_footer: Expected footer byte value (default: 0x90)

        Returns:
            True if at least 2 of 3 characters match preferred_footer.
        """
        LARGE_STRIDE = 33

        match_count = 0

        for i in range(3):
            addr = large_base + i * LARGE_STRIDE

            if addr + LARGE_STRIDE > len(self.firmware):
                return False

            byte_32 = self.firmware[addr + 32]

            if byte_32 == preferred_footer:
                match_count += 1
            elif byte_32 == 0x8F:
                pass
            else:
                return False

        return match_count >= 2

    def _find_all_7e_sequences(self, min_length=10):
        """Find all 0xXX7E sequences in firmware.

        Searches for 16-bit values where low byte = 0x7E, typically
        indicating font data structures.

        Args:
            min_length: Minimum sequence length to record

        Returns:
            List of sequence dictionaries sorted by length (descending).
        """
        search_start = 0x10000
        search_end = min(len(self.firmware), 0x1000000)

        sequences = []
        addr = search_start

        while addr + 2 < search_end:
            val = struct.unpack('<H', self.firmware[addr:addr+2])[0]

            if (val & 0xFF) == 0x7E:
                seq_start = addr
                seq_len = 0
                check_addr = addr

                while check_addr + 2 < search_end:
                    val = struct.unpack('<H', self.firmware[check_addr:check_addr+2])[0]
                    if (val & 0xFF) == 0x7E:
                        seq_len += 1
                        check_addr += 2
                    else:
                        break

                if seq_len >= min_length:
                    sequences.append({
                        'start': seq_start,
                        'length': seq_len,
                        'first_value': struct.unpack('<H', self.firmware[seq_start:seq_start+2])[0]
                    })

            addr += 2

        sequences.sort(key=lambda x: x['length'], reverse=True)
        return sequences

    def _matches_v310_font_data(self, large_base):
        """Verify if font data matches V3.1.0 reference.

        Args:
            large_base: Suspected LARGE font table base address

        Returns:
            True if first 5 characters match reference data.
        """
        try:
            with open('firmwares/ECHO MINI V3.1.0/HIFIEC10.IMG', 'rb') as f:
                fw_v310 = f.read()

            v310_base = 0x4273CA
            LARGE_STRIDE = 33

            for i in range(5):
                v310_addr = v310_base + i * LARGE_STRIDE
                v310_data = fw_v310[v310_addr:v310_addr+LARGE_STRIDE]

                test_addr = large_base + i * LARGE_STRIDE

                if test_addr + LARGE_STRIDE > len(self.firmware):
                    return False

                test_data = self.firmware[test_addr:test_addr+LARGE_STRIDE]

                if test_data != v310_data:
                    return False

            return True
        except:
            return False

    def _find_7e_sequence(self, min_length=10, max_sequences=5):
        """Search for 0xXX7E sequence pattern.

        Pattern characteristics: low byte = 0x7E, incrementing high byte
        Examples: 0x0D7E, 0x0E7E, 0x0F7E, 0x107E...

        Args:
            min_length: Minimum sequence length to consider
            max_sequences: Maximum number of sequences to analyze

        Returns:
            Starting address of best sequence, or None if not found.
        """
        search_start = 0x10000
        search_end = min(len(self.firmware), 0x1000000)

        sequences = []

        addr = search_start
        while addr + 2 < search_end:
            val = struct.unpack('<H', self.firmware[addr:addr+2])[0]

            if (val & 0xFF) == 0x7E:
                seq_start = addr

                seq_len = 0
                check_addr = addr

                while check_addr + 2 < search_end:
                    val = struct.unpack('<H', self.firmware[check_addr:check_addr+2])[0]

                    if (val & 0xFF) == 0x7E:
                        seq_len += 1
                        check_addr += 2
                    else:
                        break

                if seq_len >= min_length:
                    sequences.append({
                        'start': seq_start,
                        'length': seq_len,
                        'first_value': struct.unpack('<H', self.firmware[seq_start:seq_start+2])[0]
                    })

            addr += 2

        if sequences:
            sequences.sort(key=lambda x: x['length'], reverse=True)

            for seq in sequences[:5]:
                first_value = seq['first_value']
                if 0x0000 <= first_value <= 0x9000:
                    best = seq
                    print(f"    Found {len(sequences)} sequences, selected: length={best['length']}, start=0x{best['start']:06X}, first_value=0x{best['first_value']:04X}")
                    return best['start']

        return None

    def detect_addresses(self):
        """Detect all critical font table addresses.

        Returns:
            Dictionary with detected addresses and confidence metrics,
            or None if detection fails.
        """
        results = {}

        results['SMALL_BASE'] = self.detect_small_base()

        large_base = self.search_offset_table()

        if large_base is None:
            print("❌ Error: Unable to find valid LARGE_BASE")
            return None

        results['LARGE_BASE'] = large_base

        results['LOOKUP_TABLE'] = 0x080000

        results['confidence'] = self._validate_addresses(results)

        return results

    def _validate_addresses(self, addresses):
        """Validate detected addresses and assess confidence.

        Performs sanity checks on font data samples and searches for
        expected instruction patterns.

        Args:
            addresses: Dictionary of detected addresses

        Returns:
            Dictionary with validation metrics.
        """
        confidence = {
            'small_font_valid': 0,
            'large_font_valid': 0,
            'movw_0042_count': 0,
        }

        SMALL_STRIDE = 32
        for char_code in [0x0041, 0x0042, 0x0043]:
            addr = addresses['SMALL_BASE'] + char_code * SMALL_STRIDE
            if addr + SMALL_STRIDE <= len(self.firmware):
                chunk = self.firmware[addr:addr + SMALL_STRIDE]
                if not (all(b == 0 for b in chunk) or all(b == 0xFF for b in chunk)):
                    confidence['small_font_valid'] += 1

        LARGE_STRIDE = 33
        for char_code in [0x4E00, 0x4E01, 0x4E02]:
            addr = addresses['LARGE_BASE'] + (char_code - 0x4E00) * LARGE_STRIDE
            if addr + LARGE_STRIDE <= len(self.firmware):
                chunk = self.firmware[addr:addr + LARGE_STRIDE]
                if not (all(b == 0 for b in chunk) or all(b == 0xFF for b in chunk)):
                    confidence['large_font_valid'] += 1

        movw_count = 0
        for i in range(len(self.firmware) - 6):
            if self.firmware[i:i+2] == b'\xF2\x40' and self.firmware[i+4] == 0x42:
                movw_count += 1
        confidence['movw_0042_count'] = movw_count

        return confidence


class FontExtractor:
    """Extracts font glyphs from firmware data and exports to BMP format.

    Handles V8 font decoding with configurable bit/byte swapping modes.
    Supports both SMALL and LARGE font tables with appropriate stride values.
    """

    UNICODE_RANGES = [
        ("Basic_Latin", 0x0000, 0x007F),
        ("Latin_1_Supplement", 0x0080, 0x00FF),
        ("Latin_Extended_A", 0x0100, 0x017F),
        ("Latin_Extended_B", 0x0180, 0x024F),
        ("IPA_Extensions", 0x0250, 0x02AF),
        ("Spacing_Modifier", 0x02B0, 0x02FF),
        ("Combining_Diacritics", 0x0300, 0x036F),
        ("Greek_Coptic", 0x0370, 0x03FF),
        ("Cyrillic", 0x0400, 0x04FF),
        ("Cyrillic_Supplement", 0x0500, 0x052F),
        ("Armenian", 0x0530, 0x058F),
        ("Hebrew", 0x0590, 0x05FF),
        ("Arabic", 0x0600, 0x06FF),
        ("Syriac", 0x0700, 0x074F),
        ("Arabic_Supplement", 0x0750, 0x077F),
        ("Thaana", 0x0780, 0x07BF),
        ("NKo", 0x07C0, 0x07FF),
        ("Samaritan", 0x0800, 0x083F),
        ("Mandaic", 0x0840, 0x085F),
        ("Arabic_Extended_B", 0x0870, 0x089F),
        ("Arabic_Extended_A", 0x08A0, 0x08FF),
        ("Devanagari", 0x0900, 0x097F),
        ("Bengali", 0x0980, 0x09FF),
        ("Gurmukhi", 0x0A00, 0x0A7F),
        ("Gujarati", 0x0A80, 0x0AFF),
        ("Oriya", 0x0B00, 0x0B7F),
        ("Tamil", 0x0B80, 0x0BFF),
        ("Telugu", 0x0C00, 0x0C7F),
        ("Kannada", 0x0C80, 0x0CFF),
        ("Malayalam", 0x0D00, 0x0D7F),
        ("Sinhala", 0x0D80, 0x0DFF),
        ("Thai", 0x0E00, 0x0E7F),
        ("Lao", 0x0E80, 0x0EFF),
        ("Tibetan", 0x0F00, 0x0FFF),
        ("Myanmar", 0x1000, 0x109F),
        ("Georgian", 0x10A0, 0x10FF),
        ("Hangul_Jamo", 0x1100, 0x11FF),
        ("Ethiopic", 0x1200, 0x137F),
        ("Ethiopic_Supplement", 0x1380, 0x139F),
        ("Cherokee", 0x13A0, 0x13FF),
        ("UCAS", 0x1400, 0x167F),
        ("Ogham", 0x1680, 0x169F),
        ("Runic", 0x16A0, 0x16FF),
        ("Tagalog", 0x1700, 0x171F),
        ("Hanunoo", 0x1720, 0x173F),
        ("Buhid", 0x1740, 0x175F),
        ("Tagbanwa", 0x1760, 0x177F),
        ("Khmer", 0x1780, 0x17FF),
        ("Mongolian", 0x1800, 0x18AF),
        ("UCAS_Extended", 0x18B0, 0x18FF),
        ("Limbu", 0x1900, 0x194F),
        ("Tai_Le", 0x1950, 0x197F),
        ("New_Tai_Lue", 0x1980, 0x19DF),
        ("Khmer_Symbols", 0x19E0, 0x19FF),
        ("Buginese", 0x1A00, 0x1A1F),
        ("Tai_Tham", 0x1A20, 0x1AAF),
        ("Balinese", 0x1B00, 0x1B7F),
        ("Sundanese", 0x1B80, 0x1BBF),
        ("Batak", 0x1BC0, 0x1BFF),
        ("Lepcha", 0x1C00, 0x1C4F),
        ("Ol_Chiki", 0x1C50, 0x1C7F),
        ("Cyrillic_Extended_C", 0x1C80, 0x1C8F),
        ("Georgian_Extended", 0x1C90, 0x1CBF),
        ("Vedic_Extensions", 0x1CD0, 0x1CFF),
        ("Phonetic_Extensions", 0x1D00, 0x1D7F),
        ("Phonetic_Extensions_Sup", 0x1D80, 0x1DBF),
        ("Combining_Diacritics_Sup", 0x1DC0, 0x1DFF),
        ("Latin_Extended_Additional", 0x1E00, 0x1EFF),
        ("Greek_Extended", 0x1F00, 0x1FFF),
        ("General_Punctuation", 0x2000, 0x206F),
        ("Superscripts_Subscripts", 0x2070, 0x209F),
        ("Currency_Symbols", 0x20A0, 0x20CF),
        ("Combining_Diacritics_Sym", 0x20D0, 0x20FF),
        ("Letterlike_Symbols", 0x2100, 0x214F),
        ("Number_Forms", 0x2150, 0x218F),
        ("Arrows", 0x2190, 0x21FF),
        ("Mathematical_Operators", 0x2200, 0x22FF),
        ("Misc_Technical", 0x2300, 0x23FF),
        ("Control_Pictures", 0x2400, 0x243F),
        ("OCR", 0x2440, 0x245F),
        ("Enclosed_Alphanumerics", 0x2460, 0x24FF),
        ("Box_Drawing", 0x2500, 0x257F),
        ("Block_Elements", 0x2580, 0x259F),
        ("Geometric_Shapes", 0x25A0, 0x25FF),
        ("Misc_Symbols", 0x2600, 0x26FF),
        ("Dingbats", 0x2700, 0x27BF),
        ("Misc_Math_Symbols_A", 0x27C0, 0x27EF),
        ("Supplemental_Arrows_A", 0x27F0, 0x27FF),
        ("Braille_Patterns", 0x2800, 0x28FF),
        ("Supplemental_Arrows_B", 0x2900, 0x297F),
        ("Misc_Math_Symbols_B", 0x2980, 0x29FF),
        ("Supplemental_Math_Op", 0x2A00, 0x2AFF),
        ("Misc_Symbols_Arrows", 0x2B00, 0x2BFF),
        ("Glagolitic", 0x2C00, 0x2C5F),
        ("Latin_Extended_C", 0x2C60, 0x2C7F),
        ("Coptic", 0x2C80, 0x2CFF),
        ("Georgian_Supplement", 0x2D00, 0x2D2F),
        ("Tifinagh", 0x2D30, 0x2D7F),
        ("Ethiopic_Extended", 0x2D80, 0x2DDF),
        ("Cyrillic_Extended_A", 0x2DE0, 0x2DFF),
        ("Supplemental_Punctuation", 0x2E00, 0x2E7F),
        ("CJK_Radicals_Sup", 0x2E80, 0x2EFF),
        ("Kangxi_Radicals", 0x2F00, 0x2FDF),
        ("Ideographic_Description", 0x2FF0, 0x2FFF),
        ("CJK_Symbols_Punctuation", 0x3000, 0x303F),
        ("Hiragana", 0x3040, 0x309F),
        ("Katakana", 0x30A0, 0x30FF),
        ("Bopomofo", 0x3100, 0x312F),
        ("Hangul_Compatibility", 0x3130, 0x318F),
        ("Kanbun", 0x3190, 0x319F),
        ("Bopomofo_Extended", 0x31A0, 0x31BF),
        ("CJK_Strokes", 0x31C0, 0x31EF),
        ("Katakana_Phonetic", 0x31F0, 0x31FF),
        ("Enclosed_CJK", 0x3200, 0x32FF),
        ("CJK_Compatibility", 0x3300, 0x33FF),
        ("CJK_Extension_A", 0x3400, 0x4DBF),
        ("Yijing_Hexagrams", 0x4DC0, 0x4DFF),
        ("CJK_Unified", 0x4E00, 0x9FFF),
        ("Yi_Syllables", 0xA000, 0xA48F),
        ("Yi_Radicals", 0xA490, 0xA4CF),
        ("Lisu", 0xA4D0, 0xA4FF),
        ("Vai", 0xA500, 0xA63F),
        ("Cyrillic_Extended_B", 0xA640, 0xA69F),
        ("Bamum", 0xA6A0, 0xA6FF),
        ("Modifier_Tone_Letters", 0xA700, 0xA71F),
        ("Latin_Extended_D", 0xA720, 0xA7FF),
        ("Syloti_Nagri", 0xA800, 0xA82F),
        ("Indic_Number_Forms", 0xA830, 0xA83F),
        ("Phags_pa", 0xA840, 0xA87F),
        ("Saurashtra", 0xA880, 0xA8DF),
        ("Devanagari_Extended", 0xA8E0, 0xA8FF),
        ("Kayah_Li", 0xA900, 0xA92F),
        ("Rejang", 0xA930, 0xA95F),
        ("Hangul_Jamo_Extended_A", 0xA960, 0xA97F),
        ("Javanese", 0xA980, 0xA9DF),
        ("Myanmar_Extended_B", 0xA9E0, 0xA9FF),
        ("Cham", 0xAA00, 0xAA5F),
        ("Myanmar_Extended_A", 0xAA60, 0xAA7F),
        ("Tai_Viet", 0xAA80, 0xAADF),
        ("Meetei_Mayek_Ext", 0xAAE0, 0xAAFF),
        ("Ethiopic_Extended_A", 0xAB00, 0xAB2F),
        ("Latin_Extended_E", 0xAB30, 0xAB6F),
        ("Cherokee_Supplement", 0xAB70, 0xABBF),
        ("Meetei_Mayek", 0xABC0, 0xABFF),
        ("Hangul_Syllables", 0xAC00, 0xD7AF),
        ("Hangul_Jamo_Extended_B", 0xD7B0, 0xD7FF),
        ("Private_Use_Area", 0xE000, 0xF8FF),
        ("CJK_Compatibility_Ideographs", 0xF900, 0xFAFF),
        ("Alphabetic_Presentation_Forms", 0xFB00, 0xFB4F),
        ("Arabic_Presentation_Forms_A", 0xFB50, 0xFDFF),
        ("Variation_Selectors", 0xFE00, 0xFE0F),
        ("Vertical_Forms", 0xFE10, 0xFE1F),
        ("Combining_Half_Marks", 0xFE20, 0xFE2F),
        ("CJK_Compatibility_Forms", 0xFE30, 0xFE4F),
        ("Small_Form_Variants", 0xFE50, 0xFE6F),
        ("Arabic_Presentation_Forms_B", 0xFE70, 0xFEFF),
        ("Halfwidth_Fullwidth", 0xFF00, 0xFFEF),
        ("Specials", 0xFFF0, 0xFFFF),
    ]

    def __init__(self, firmware, addresses, unicode_ranges=None):
        """Initialize font extractor.

        Args:
            firmware: Raw firmware data as bytes
            addresses: Dictionary with SMALL_BASE, LARGE_BASE, LOOKUP_TABLE
            unicode_ranges: Optional custom list of (name, start, end) tuples
        """
        self.firmware = firmware
        self.SMALL_BASE = addresses['SMALL_BASE']
        self.LARGE_BASE = addresses['LARGE_BASE']
        self.LOOKUP_TABLE = addresses['LOOKUP_TABLE']
        self.SMALL_STRIDE = 32
        self.LARGE_STRIDE = 33

        if unicode_ranges:
            self.UNICODE_RANGES = unicode_ranges

    def unicode_to_small_addr(self, unicode_val):
        """Convert Unicode code point to SMALL font table address.

        Args:
            unicode_val: Unicode code point

        Returns:
            Physical address in firmware
        """
        return self.SMALL_BASE + unicode_val * self.SMALL_STRIDE

    def unicode_to_large_addr(self, unicode_val):
        """Convert Unicode code point to LARGE font table address.

        Args:
            unicode_val: Unicode code point (must be >= 0x4E00)

        Returns:
            Physical address in firmware
        """
        return self.LARGE_BASE + (unicode_val - 0x4E00) * self.LARGE_STRIDE

    def get_lookup(self, unicode_val):
        """Get lookup table value for Unicode code point.

        Args:
            unicode_val: Unicode code point

        Returns:
            Lookup configuration byte
        """
        return self.firmware[self.LOOKUP_TABLE + (unicode_val >> 3)]

    def decode_v8(self, chunk, lookup_val):
        """Decode V8 format font data into pixel rows.

        Args:
            chunk: Raw font data bytes (16 bytes per character)
            lookup_val: Configuration value from lookup table

        Returns:
            List of pixel rows (16 rows x 15 bits each)
        """
        config_byte = lookup_val & 0xFF
        sw_mcu_bits = (config_byte >> 3) & 1
        sw_mcu_hw_swap = (config_byte >> 4) & 1
        sw_mcu_byte_swap = (config_byte >> 5) & 1

        pixels = []
        for i in range(0, len(chunk), 2):
            if i + 1 >= len(chunk):
                break

            b0, b1 = chunk[i], chunk[i+1]

            if sw_mcu_bits == 1:
                val = (b1 << 8) | b0
                if sw_mcu_byte_swap:
                    val = ((val & 0xFF) << 8) | ((val >> 8) & 0xFF)
                final_pixel = val
            else:
                cycle_1, cycle_2 = (b1, b0) if sw_mcu_hw_swap == sw_mcu_byte_swap else (b0, b1)
                if sw_mcu_byte_swap:
                    cycle_1, cycle_2 = cycle_2, cycle_1
                if sw_mcu_hw_swap:
                    cycle_1, cycle_2 = cycle_2, cycle_1
                final_pixel = cycle_2 | (cycle_1 << 8)

            if not ((sw_mcu_bits == 1) and (sw_mcu_byte_swap == 1)):
                final_pixel = ((final_pixel & 0xFF) << 8) | ((final_pixel >> 8) & 0xFF)

            row_bits = [(final_pixel >> bit) & 1 for bit in range(15, -1, -1)]
            pixels.append(row_bits)

        return pixels

    def write_bmp(self, path, pixels, width=16, height=16):
        """Write monochrome BMP file.

        Args:
            path: Output file path
            pixels: 2D list of bits (0 or 1)
            width: Image width in pixels
            height: Image height in pixels
        """
        import struct as struct_pkg
        bfType = 0x4D42
        bfOffBits = 62
        biSize = 40
        biWidth = width
        biHeight = height
        biBitCount = 1
        biSizeImage = ((width + 31) // 32) * 4 * height

        file_size = bfOffBits + biSizeImage

        with open(path, 'wb') as f:
            f.write(struct_pkg.pack('<H', bfType))
            f.write(struct_pkg.pack('<I', file_size))
            f.write(struct_pkg.pack('<H', 0))
            f.write(struct_pkg.pack('<H', 0))
            f.write(struct_pkg.pack('<I', bfOffBits))
            f.write(struct_pkg.pack('<I', biSize))
            f.write(struct_pkg.pack('<i', biWidth))
            f.write(struct_pkg.pack('<i', biHeight))
            f.write(struct_pkg.pack('<H', 1))
            f.write(struct_pkg.pack('<H', biBitCount))
            f.write(struct_pkg.pack('<I', 0))
            f.write(struct_pkg.pack('<I', biSizeImage))
            f.write(struct_pkg.pack('<i', 2835))
            f.write(struct_pkg.pack('<i', 2835))
            f.write(struct_pkg.pack('<I', 2))
            f.write(struct_pkg.pack('<I', 2))

            for color in [0xFFFFFF, 0x000000]:
                f.write(struct_pkg.pack('BBBB', color & 0xFF, (color >> 8) & 0xFF, (color >> 16) & 0xFF, 0))

            row_bytes = ((width + 31) // 32) * 4

            for y in range(height - 1, -1, -1):
                row_data = []
                current_byte = 0
                bit_count = 0

                for x in range(width):
                    bit = pixels[y][x] if y < len(pixels) and x < len(pixels[y]) else 0
                    current_byte = (current_byte << 1) | bit
                    bit_count += 1

                    if bit_count == 8:
                        row_data.append(current_byte)
                        current_byte = 0
                        bit_count = 0

                if bit_count > 0:
                    current_byte <<= (8 - bit_count)
                    row_data.append(current_byte)

                while len(row_data) < row_bytes:
                    row_data.append(0)

                f.write(bytes(row_data))

    def is_valid_font_data(self, pixels, font_type):
        """Validate font data by checking pixel fill ratio.

        Args:
            pixels: 2D list of pixel bits
            font_type: Either "SMALL" or "LARGE"

        Returns:
            True if fill ratio is within acceptable bounds.
        """
        total = sum(len(r) for r in pixels)
        if total == 0:
            return False
        filled = sum(sum(r) for r in pixels)
        ratio = filled / total

        if font_type == "LARGE":
            return 0.01 < ratio < 0.97
        else:
            return 0.01 < ratio < 0.95

    def extract_font_range(self, start, end, font_type, addr_func, stride, output_dir, range_name=""):
        """Extract fonts for a Unicode range.

        Args:
            start: Start of Unicode range
            end: End of Unicode range
            font_type: Either "SMALL" or "LARGE"
            addr_func: Function to convert Unicode to address
            stride: Font entry stride in bytes
            output_dir: Base output directory
            range_name: Optional descriptive name for range

        Returns:
            Number of fonts successfully extracted.
        """
        range_prefix = f"U+{start:04X}-{end:04X}_{range_name}" if range_name else f"U+{start:04X}-{end:04X}"
        out_dir = os.path.join(output_dir, font_type, range_prefix)
        os.makedirs(out_dir, exist_ok=True)

        count = 0
        for uni in range(start, end + 1):
            addr = addr_func(uni)

            if addr < 0 or addr + stride > len(self.firmware):
                continue

            chunk = self.firmware[addr:addr + stride]

            if all(b == 0 for b in chunk) or all(b == 0xFF for b in chunk):
                continue

            try:
                lookup_val = self.get_lookup(uni)
                pixels = self.decode_v8(chunk, lookup_val)

                if not pixels or len(pixels) != 16:
                    continue

                if not self.is_valid_font_data(pixels, font_type):
                    continue

                header = lookup_val & 0xFF
                name = f"0x{addr:06X}_H{header:02X}_U+{uni:04X}.bmp"

                # For SMALL fonts, only extract the top-left 10x10 pixels
                if font_type == "SMALL":
                    pixels = [row[:10] for row in pixels[:10]]
                    self.write_bmp(os.path.join(out_dir, name), pixels, width=10, height=10)
                else:
                    self.write_bmp(os.path.join(out_dir, name), pixels)
                count += 1

            except Exception:
                continue

            if count % 100 == 0:
                print(f"  {font_type}: {count} extracted (U+{uni:04X})...")

        print(f"  {font_type} {range_prefix}: {count} extracted")
        return count

    def extract_all(self, output_dir):
        """Extract all fonts for configured Unicode ranges.

        Args:
            output_dir: Base output directory
        """
        print("\nScanning Unicode ranges...")
        print("=" * 80)

        total_small = 0
        total_large = 0

        for name, start, end in self.UNICODE_RANGES:
            print(f"\nProcessing: {name} (U+{start:04X} - U+{end:04X})")

            s_count = self.extract_font_range(
                start, end, "SMALL",
                self.unicode_to_small_addr,
                self.SMALL_STRIDE,
                output_dir, name
            )
            total_small += s_count

            l_count = self.extract_font_range(
                start, end, "LARGE",
                self.unicode_to_large_addr,
                self.LARGE_STRIDE,
                output_dir, name
            )
            total_large += l_count

        print("\n" + "=" * 80)
        print("DONE!")
        print(f"  SMALL: {total_small} fonts extracted")
        print(f"  LARGE: {total_large} fonts extracted")
        print(f"  Output: {output_dir}")
        print("=" * 80)


def main():
    """Main entry point for font extraction.

    Parses command-line arguments, detects font table addresses,
    and orchestrates the extraction process.
    """
    parser = argparse.ArgumentParser(
        description='Universal Font Extractor - Heuristic Offset Table Search',
        epilog='Example: python extract_font_universal.py firmware.img --range "CJK:0x4E00:0x9FFF"'
    )
    parser.add_argument('firmware', help='Path to firmware .IMG file')
    parser.add_argument('-o', '--output', default='extracted_font_universal')
    parser.add_argument('--verify-only', action='store_true')
    parser.add_argument('--range', action='append', dest='ranges',
                       help='Unicode range in format "name:start:end" (can be used multiple times)')

    args = parser.parse_args()

    unicode_ranges = None
    if args.ranges:
        unicode_ranges = []
        for r in args.ranges:
            try:
                parts = r.split(':')
                if len(parts) == 3:
                    name, start, end = parts
                    unicode_ranges.append((name, int(start, 16), int(end, 16)))
                else:
                    print(f"Warning: Invalid range format {r}", file=sys.stderr)
            except ValueError as e:
                print(f"Warning: Failed to parse range {r}: {e}", file=sys.stderr)
    if not os.path.isfile(args.firmware):
        print(f"Error: Firmware file not found: {args.firmware}")
        sys.exit(1)

    import sys
    print("=" * 80)
    print("Universal Font Extractor - Heuristic Offset Table Search")
    print("=" * 80)
    print(f"\nFirmware: {args.firmware}")

    analyzer = FirmwareAnalyzer(args.firmware)
    addresses = analyzer.detect_addresses()

    if addresses is None:
        sys.exit(1)

    print("\n=== Heuristic Detection Results ===")
    print(f"SMALL_BASE:     0x{addresses['SMALL_BASE']:06X}")
    print(f"LARGE_BASE:     0x{addresses['LARGE_BASE']:06X}")
    print(f"LOOKUP_TABLE:   0x{addresses['LOOKUP_TABLE']:06X}")
    print()
    print("=== Validation ===")
    print(f"SMALL font samples: {addresses['confidence']['small_font_valid']}/3 valid")
    print(f"LARGE font samples: {addresses['confidence']['large_font_valid']}/3 valid")
    print(f"MOVW #0x0042 count: {addresses['confidence']['movw_0042_count']} (expected ~12)")

    if addresses['confidence']['small_font_valid'] < 2 or addresses['confidence']['large_font_valid'] < 2:
        print("\n⚠️  Warning: Low confidence in detected addresses!")
        sys.exit(1)

    if args.verify_only:
        print("\n✅ Verification complete.")
        sys.exit(0)

    extractor = FontExtractor(analyzer.firmware, addresses, unicode_ranges)
    extractor.extract_all(args.output)


if __name__ == '__main__':
    main()
