"""Generate pinned Unicode data for canonical product-category matching offline."""

import argparse
import hashlib
from pathlib import Path


INPUT_HASHES = {
    "UnicodeData.txt": (
        "2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c"
    ),
    "DerivedCoreProperties.txt": (
        "24c7fed1195c482faaefd5c1e7eb821c5ee1fb6de07ecdbaa64b56a99da22c08"
    ),
    "SpecialCasing.txt": (
        "efc25faf19de21b92c1194c111c932e03d2a5eaf18194e33f1156e96de4c9588"
    ),
    "LICENSE": (
        "e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96"
    ),
}


def read_inputs(directory):
    inputs = {}

    for name, expected in INPUT_HASHES.items():
        data = (directory / name).read_bytes()

        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f"Unexpected Unicode 17 input: {name}")

        inputs[name] = data.decode("utf-8")

    return inputs


def simple_lowercase(source):
    mappings = {}

    for line in source.splitlines():
        if not line:
            continue

        fields = line.split(";")

        if len(fields) != 15:
            raise ValueError("Invalid UnicodeData row")

        if fields[13]:
            mappings[int(fields[0], 16)] = int(fields[13], 16)

    if len(mappings) != 1488:
        raise ValueError("Unexpected simple lowercase mapping count")

    return mappings


def check_special_casing(source, mappings):
    overrides = {}
    contexts = []

    for line in source.splitlines():
        data = line.partition("#")[0].strip()

        if not data:
            continue

        fields = [field.strip() for field in data.split(";")]
        code_point = int(fields[0], 16)
        lowered = tuple(int(value, 16) for value in fields[1].split())
        condition = fields[4]

        if not condition:
            if lowered != (mappings.get(code_point, code_point),):
                overrides[code_point] = lowered
        elif not {"lt", "tr", "az"}.intersection(condition.split()):
            contexts.append((code_point, condition, lowered))

    if overrides != {0x0130: (0x0069, 0x0307)}:
        raise ValueError("Unexpected default lowercase expansion")

    if contexts != [(0x03A3, "Final_Sigma", (0x03C2,))]:
        raise ValueError("Unexpected default lowercase context")


def merge_ranges(ranges):
    merged = []

    for start, end in sorted(ranges):
        if merged and start <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))

    return merged


def case_properties(source):
    properties = {"Cased": [], "Case_Ignorable": []}

    for line in source.splitlines():
        data = line.partition("#")[0].strip()

        if not data:
            continue

        fields = [field.strip() for field in data.split(";")]
        name = fields[1]

        if name not in properties:
            continue

        boundaries = fields[0].split("..")
        properties[name].append((int(boundaries[0], 16), int(boundaries[-1], 16)))

    for name, expected in {"Cased": 4632, "Case_Ignorable": 2794}.items():
        properties[name] = merge_ranges(properties[name])
        count = sum(end - start + 1 for start, end in properties[name])

        if count != expected:
            raise ValueError(f"Unexpected Unicode property count: {name}")

    return properties


def render_data(mappings, properties, license_text):
    if "'''" in license_text:
        raise ValueError("Unicode license cannot be represented as a raw literal")

    lines = [
        "// Generated Unicode 17.0.0 data; do not edit the tables by hand.",
        "// Generator: tool/generate_product_category_unicode.py",
        "// Sources: https://www.unicode.org/Public/17.0.0/ucd/",
        "// Full lowercase also requires U+0130 expansion and Final_Sigma context.",
        "",
        "const productCategorySimpleLowercase = <int, int>{",
    ]
    lines.extend(
        f"  0x{source:04x}: 0x{target:04x},"
        for source, target in sorted(mappings.items())
    )
    lines.append("};")

    for property_name, dart_name in [
        ("Cased", "productCategoryCasedRanges"),
        ("Case_Ignorable", "productCategoryCaseIgnorableRanges"),
    ]:
        lines.extend(["", f"const {dart_name} = <(int, int)>["])
        lines.extend(
            f"  (0x{start:04x}, 0x{end:04x}),"
            for start, end in properties[property_name]
        )
        lines.append("];")

    lines.extend([
        "",
        "const productCategoryUnicodeLicense = r'''" + license_text + "''';",
        "",
    ])

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-directory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()

    # Inputs must be downloaded separately; this tool performs no network I/O.
    inputs = read_inputs(arguments.input_directory)
    mappings = simple_lowercase(inputs["UnicodeData.txt"])
    check_special_casing(inputs["SpecialCasing.txt"], mappings)
    properties = case_properties(inputs["DerivedCoreProperties.txt"])
    generated = render_data(mappings, properties, inputs["LICENSE"])

    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_bytes(generated.encode("utf-8"))

    print(f"Generated {len(mappings)} mappings: {arguments.output}")


if __name__ == "__main__":
    main()
