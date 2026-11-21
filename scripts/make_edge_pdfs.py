"""
Generate the small edge-case PDFs in test/pdfs/generated/.

Papers rarely contain these cases, so they are drawn here instead: rotation,
odd page boxes, form fields, encryption and broken files. Every page is
synthetic (base-14 Helvetica, a 72 pt grid, a border on the MediaBox, corner
labels and an "up" arrow), so orientation and cropping can be checked by eye
on a render and there is no third-party content to licence.

    python3 scripts/make_edge_pdfs.py

Needs `pypdf` (pip install pypdf). Without the `cryptography` package pypdf
can only write RC4 encryption, which is what this uses. The output is
deterministic: a fixed /ID, fixed metadata and no timestamps, so rerunning it
changes nothing unless this script changed.

See test/pdfs/SOURCES.md for what each file is for, and
docs/plan_own_pdf_engine.md Phase 0.
"""

from __future__ import annotations

import hashlib
import io
from pathlib import Path

from pypdf import PdfWriter
from pypdf.constants import UserAccessPermissions
from pypdf.generic import (
    ArrayObject,
    BooleanObject,
    ByteStringObject,
    DictionaryObject,
    FloatObject,
    IndirectObject,
    NameObject,
    NumberObject,
    StreamObject,
    TextStringObject,
)

OUT = Path(__file__).resolve().parent.parent / "test" / "pdfs" / "generated"

LETTER = (0, 0, 612, 792)

# Passwords for the encrypted fixtures. They protect nothing; the tests need
# to know them. Mirrored in test/pdfs/SOURCES.md.
USER_PASSWORD = "hover-user"
OWNER_PASSWORD = "hover-owner"


# ---------------------------------------------------------------------------
# Drawing


def _num(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def _text(x: float, y: float, size: float, s: str) -> str:
    s = s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return f"BT /F1 {_num(size)} Tf {_num(x)} {_num(y)} Td ({s}) Tj ET\n"


def page_content(box: tuple[float, float, float, float], title: str, lines: list[str]) -> bytes:
    """A page drawn in `box` (user space): grid, border, corners, arrow, text."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    out = []

    # Grid every 72 pt from the box origin, light grey.
    out.append("q 0.85 G 0.5 w\n")
    gx = x0 + 72
    while gx < x1:
        out.append(f"{_num(gx)} {_num(y0)} m {_num(gx)} {_num(y1)} l S\n")
        gx += 72
    gy = y0 + 72
    while gy < y1:
        out.append(f"{_num(x0)} {_num(gy)} m {_num(x1)} {_num(gy)} l S\n")
        gy += 72
    out.append("Q\n")

    # Border on the box, blue, 4 pt inset so a crop to the box keeps it.
    out.append(f"q 0 0 0.8 RG 2 w {_num(x0 + 4)} {_num(y0 + 4)} {_num(w - 8)} {_num(h - 8)} re S Q\n")

    # Up arrow in the centre, red. It points to the top of the unrotated page.
    cx, cy = x0 + w / 2, y0 + h / 2
    out.append(
        "q 0.85 0.1 0.1 rg "
        f"{_num(cx - 12)} {_num(cy - 60)} 24 80 re f "
        f"{_num(cx - 36)} {_num(cy + 20)} m {_num(cx + 36)} {_num(cy + 20)} l "
        f"{_num(cx)} {_num(cy + 70)} l h f Q\n"
    )
    out.append("0 g\n")
    out.append(_text(cx - 10, cy + 78, 12, "UP"))

    # Corner labels with their user-space coordinates.
    pad = 14
    out.append(_text(x0 + pad, y1 - pad - 10, 10, f"TOP LEFT ({_num(x0)}, {_num(y1)})"))
    out.append(_text(x1 - pad - 150, y1 - pad - 10, 10, f"TOP RIGHT ({_num(x1)}, {_num(y1)})"))
    out.append(_text(x0 + pad, y0 + pad, 10, f"BOTTOM LEFT ({_num(x0)}, {_num(y0)})"))
    out.append(_text(x1 - pad - 150, y0 + pad, 10, f"BOTTOM RIGHT ({_num(x1)}, {_num(y0)})"))

    # Title and description lines, top left under the corner label.
    ty = y1 - 72
    out.append(_text(x0 + 36, ty, 18, title))
    for line in lines:
        ty -= 16
        out.append(_text(x0 + 36, ty, 11, line))
    return "".join(out).encode("latin-1")


# ---------------------------------------------------------------------------
# Writer helpers


def new_writer(title: str) -> PdfWriter:
    w = PdfWriter()
    w.add_metadata(
        {
            "/Title": title,
            "/Producer": "hover scripts/make_edge_pdfs.py",
            "/Creator": "hover scripts/make_edge_pdfs.py",
        }
    )
    # Fixed file ID derived from the title, so output is reproducible.
    digest = hashlib.md5(title.encode()).digest()
    w._ID = ArrayObject([ByteStringObject(digest), ByteStringObject(digest)])
    return w


def encrypt(w: PdfWriter, **kwargs) -> None:
    """Encrypt, keeping the fixed /ID: pypdf randomises its second half."""
    fixed = w._ID
    w.encrypt(**kwargs)
    w._ID = fixed


def helvetica(w: PdfWriter) -> IndirectObject:
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
            NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
        }
    )
    return w._add_object(font)


def stream(w: PdfWriter, data: bytes, extra: dict | None = None) -> IndirectObject:
    s = StreamObject()
    s.set_data(data)
    for k, v in (extra or {}).items():
        s[NameObject(k)] = v
    return w._add_object(s)


def rect(*v: float) -> ArrayObject:
    return ArrayObject([FloatObject(x) for x in v])


def add_page(
    w: PdfWriter,
    font: IndirectObject,
    *,
    media: tuple[float, float, float, float] | None = LETTER,
    crop: tuple[float, float, float, float] | None = None,
    rotate: int | None = None,
    title: str = "",
    lines: list[str] | None = None,
    draw_box: tuple[float, float, float, float] | None = None,
    contents: bool = True,
):
    """Add a page. `media=None` leaves MediaBox off the page (inherited)."""
    page = w.add_blank_page(width=612, height=792)
    if media is None:
        del page[NameObject("/MediaBox")]
    else:
        page[NameObject("/MediaBox")] = rect(*media)
    if crop is not None:
        page[NameObject("/CropBox")] = rect(*crop)
    if rotate is not None:
        page[NameObject("/Rotate")] = NumberObject(rotate)
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
    )
    if contents:
        box = draw_box or media or LETTER
        page[NameObject("/Contents")] = stream(w, page_content(box, title, lines or []))
    return page


def save(w: PdfWriter, name: str) -> bytes:
    buf = io.BytesIO()
    w.write(buf)
    data = buf.getvalue()
    (OUT / name).write_bytes(data)
    print(f"  {name:32s} {len(data):7d} bytes")
    return data


# ---------------------------------------------------------------------------
# Fixtures


def rotated() -> bytes:
    w = new_writer("Hover fixture: rotation")
    f = helvetica(w)
    for r in (0, 90, 180, 270):
        add_page(w, f, rotate=r, title=f"/Rotate {r}",
                 lines=[f"The red arrow points to the page's top before rotation.",
                        f"Displayed, it should point {['up', 'right', 'down', 'left'][r // 90]}."])
    # Out-of-range values that readers normalise. Not valid per the spec
    # (multiples of 90 in 0..270 are), but they occur in the wild.
    add_page(w, f, rotate=-90, title="/Rotate -90",
             lines=["Not a canonical value. Readers treat it as 270: arrow points left."])
    add_page(w, f, rotate=450, title="/Rotate 450",
             lines=["Not a canonical value. Readers treat it as 90: arrow points right."])
    return save(w, "rotated.pdf")


def boxes() -> bytes:
    w = new_writer("Hover fixture: page boxes")
    f = helvetica(w)
    add_page(w, f, crop=(72, 72, 540, 720), title="CropBox inset",
             lines=["MediaBox 0 0 612 792, CropBox 72 72 540 720.",
                    "Displayed size is 468 x 648. The outer grid square is cut off."])
    add_page(w, f, media=(-100, -100, 512, 692), title="MediaBox off origin",
             lines=["MediaBox -100 -100 512 692, no CropBox.",
                    "Displayed size is 612 x 792, the same as letter."])
    add_page(w, f, crop=(-50, -50, 700, 900), title="CropBox past MediaBox",
             lines=["MediaBox 0 0 612 792, CropBox -50 -50 700 900.",
                    "The spec clips the CropBox to the MediaBox: 612 x 792."])
    add_page(w, f, crop=(72, 144, 540, 720), rotate=90, title="CropBox and /Rotate 90",
             lines=["CropBox 72 144 540 720 (468 x 576) then rotated.",
                    "Displayed size is 576 x 468, arrow pointing right."])
    add_page(w, f, media=(0, 0, 842, 595), title="A4 landscape",
             lines=["MediaBox 0 0 842 595: a second page size in one document."])
    add_page(w, f, media=None, draw_box=LETTER, title="Inherited MediaBox",
             lines=["This page has no MediaBox. It inherits 0 0 612 792 from /Pages."])
    add_page(w, f, contents=False)
    # The page tree root carries the MediaBox the sixth page inherits.
    w._root_object["/Pages"].get_object()[NameObject("/MediaBox")] = rect(*LETTER)
    return save(w, "boxes.pdf")


def forms() -> bytes:
    """
    AcroForm widgets. Text and checkbox fields carry their own /AP; the combo
    box doesn't, and /NeedAppearances asks the reader to build one. Phase 3
    records whether rendering without annotations draws any of them.
    """
    w = new_writer("Hover fixture: form fields")
    f = helvetica(w)
    page = add_page(w, f, title="Form fields",
                    lines=["Text field with /AP (value 'Hover').",
                           "Checkbox with /AP, checked.",
                           "Combo box without /AP; /NeedAppearances is true.",
                           "Push button with /AP."])
    page_ref = page.indirect_reference

    def form_xobject(bbox: tuple[float, float, float, float], body: bytes) -> IndirectObject:
        return stream(w, body, {
            "/Type": NameObject("/XObject"),
            "/Subtype": NameObject("/Form"),
            "/BBox": rect(*bbox),
            "/Resources": DictionaryObject(
                {NameObject("/Font"): DictionaryObject({NameObject("/Helv"): f})}),
        })

    def widget(fields: dict) -> IndirectObject:
        d = DictionaryObject({
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Widget"),
            NameObject("/F"): NumberObject(4),
            NameObject("/P"): page_ref,
        })
        for k, v in fields.items():
            d[NameObject(k)] = v
        return w._add_object(d)

    text_ap = form_xobject((0, 0, 200, 24),
                           b"0.95 0.95 1 rg 0 0 200 24 re f 0 0 0.6 RG 1 w 0.5 0.5 199 23 re S "
                           b"/Tx BMC BT /Helv 12 Tf 0 g 4 7 Td (Hover) Tj ET EMC")
    text = widget({
        "/FT": NameObject("/Tx"),
        "/T": TextStringObject("name"),
        "/V": TextStringObject("Hover"),
        "/DA": TextStringObject("/Helv 12 Tf 0 g"),
        "/Rect": rect(300, 560, 500, 584),
        "/AP": DictionaryObject({NameObject("/N"): text_ap}),
    })

    on_ap = form_xobject((0, 0, 18, 18),
                         b"1 1 1 rg 0 0 18 18 re f 0 G 1 w 0.5 0.5 17 17 re S "
                         b"0 0.5 0 RG 2 w 3 9 m 7 4 l 15 14 l S")
    off_ap = form_xobject((0, 0, 18, 18), b"1 1 1 rg 0 0 18 18 re f 0 G 1 w 0.5 0.5 17 17 re S")
    check = widget({
        "/FT": NameObject("/Btn"),
        "/T": TextStringObject("agree"),
        "/V": NameObject("/Yes"),
        "/AS": NameObject("/Yes"),
        "/Rect": rect(300, 530, 318, 548),
        "/AP": DictionaryObject({NameObject("/N"): DictionaryObject({
            NameObject("/Yes"): on_ap, NameObject("/Off"): off_ap})}),
    })

    combo = widget({
        "/FT": NameObject("/Ch"),
        "/Ff": NumberObject(1 << 17),
        "/T": TextStringObject("colour"),
        "/Opt": ArrayObject([TextStringObject(s) for s in ("Yellow", "Green", "Blue")]),
        "/V": TextStringObject("Green"),
        "/DA": TextStringObject("/Helv 12 Tf 0 g"),
        "/Rect": rect(300, 496, 500, 520),
        "/MK": DictionaryObject({NameObject("/BG"): ArrayObject([FloatObject(1), FloatObject(1), FloatObject(0.85)])}),
    })

    button_ap = form_xobject((0, 0, 100, 24),
                             b"0.8 0.8 0.8 rg 0 0 100 24 re f "
                             b"BT /Helv 12 Tf 0 g 28 7 Td (Submit) Tj ET")
    button = widget({
        "/FT": NameObject("/Btn"),
        "/Ff": NumberObject(1 << 16),
        "/T": TextStringObject("submit"),
        "/Rect": rect(300, 456, 400, 480),
        "/AP": DictionaryObject({NameObject("/N"): button_ap}),
    })

    fields = [text, check, combo, button]
    page[NameObject("/Annots")] = ArrayObject(fields)
    w._root_object[NameObject("/AcroForm")] = w._add_object(DictionaryObject({
        NameObject("/Fields"): ArrayObject(fields),
        NameObject("/NeedAppearances"): BooleanObject(True),
        NameObject("/DA"): TextStringObject("/Helv 12 Tf 0 g"),
        NameObject("/DR"): DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/Helv"): f})}),
    }))
    return save(w, "forms.pdf")


def two_page(title: str, lines: list[str]) -> PdfWriter:
    w = new_writer(title)
    f = helvetica(w)
    add_page(w, f, title=title, lines=lines)
    add_page(w, f, title="Page 2", lines=["Second page of the same document."])
    return w


def encrypted_user_password() -> bytes:
    w = two_page("Encrypted: user password",
                 [f"RC4 128-bit. User password '{USER_PASSWORD}',",
                  f"owner password '{OWNER_PASSWORD}'.",
                  "Opening without a password must fail cleanly."])
    encrypt(w, user_password=USER_PASSWORD, owner_password=OWNER_PASSWORD, algorithm="RC4-128")
    return save(w, "encrypted-user-password.pdf")


def encrypted_owner_only() -> bytes:
    w = two_page("Encrypted: owner password only",
                 ["RC4 128-bit with an empty user password: it opens without",
                  "asking, but printing, copying and modifying are not permitted."])
    encrypt(w, user_password="", owner_password=OWNER_PASSWORD, algorithm="RC4-128",
              permissions_flag=UserAccessPermissions(0))
    return save(w, "encrypted-owner-only.pdf")


def broken(source: bytes) -> None:
    # Cut mid-way through the objects: no xref, no trailer, missing objects.
    cut = source[: len(source) * 6 // 10]
    (OUT / "truncated.pdf").write_bytes(cut)
    print(f"  {'truncated.pdf':32s} {len(cut):7d} bytes")

    # Every object intact, but startxref points at the wrong place. PDFium
    # rebuilds the cross-reference table by scanning, so this one should open.
    i = source.rindex(b"startxref")
    j = source.index(b"\n", i + len(b"startxref\n"))
    bad = source[: i + len(b"startxref\n")] + b"123" + source[j:]
    (OUT / "bad-startxref.pdf").write_bytes(bad)
    print(f"  {'bad-startxref.pdf':32s} {len(bad):7d} bytes")

    # What a user gets when a publisher serves an error page under a .pdf URL.
    html = (b"<!DOCTYPE html>\n<html><head><title>Page Not Found</title></head>\n"
            b"<body><h1>Page Not Found</h1><p>This is an HTML page saved as .pdf.</p></body></html>\n")
    (OUT / "not-a-pdf.pdf").write_bytes(html)
    print(f"  {'not-a-pdf.pdf':32s} {len(html):7d} bytes")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"Writing {OUT}")
    src = rotated()
    boxes()
    forms()
    encrypted_user_password()
    encrypted_owner_only()
    broken(src)


if __name__ == "__main__":
    main()
