# Test PDFs

The PDFs that the PDFium baselines run against (`docs/plan_own_pdf_engine.md`
Phase 0). The analysis fixtures still read the four files in
`marketing/List of Papers/`.

This repo is public. Every paper here is CC BY 4.0 or in the public domain.
Each is redistributed **unmodified**; only the file name changed. If you add
one, give its source, licence and SHA-256 here.

## Papers (`papers/`)

| File | Paper | Source | Licence |
| ---- | ----- | ------ | ------- |
| `arxiv-acl-adaptive-retrieval.pdf` | Mallen, Asai, Zhong, Das, Khashabi, Hajishirzi. *When Not to Trust Language Models: Investigating Effectiveness of Parametric and Non-Parametric Memories.* ACL 2023. | [arXiv:2212.10511v4](https://arxiv.org/abs/2212.10511v4) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `arxiv-cvpr-convnext.pdf` | Liu, Mao, Wu, Feichtenhofer, Darrell, Xie. *A ConvNet for the 2020s.* CVPR 2022. | [arXiv:2201.03545v2](https://arxiv.org/abs/2201.03545v2) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `ncomms-oxide-ion-conduction.pdf` | Kanenori, Udagawa, Saito, Sakuda, Fujii, Kluczny et al. *Vacancy-mediated ultrafast oxide-ion conduction in excess-oxygen Sillén oxybromides.* Nature Communications 17, 10361 (2026). | [doi:10.1038/s41467-026-77848-8](https://doi.org/10.1038/s41467-026-77848-8) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `elsevier-jphon-alutiiq-prosody.pdf` | Alden, Arnhold. *Quantitative evidence of complex metrical prosody in Chugach Alutiiq.* Journal of Phonetics 115, 101483 (2026). | [doi:10.1016/j.wocn.2026.101483](https://doi.org/10.1016/j.wocn.2026.101483) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `elsevier-anbehav-wolves-dogs.pdf` | Rivas-Blanco, Krause, Marshall-Pescini, Range. *Inference in wolves and dogs: the 'cups task', revisited.* Animal Behaviour 227, 123268 (2025). | [doi:10.1016/j.anbehav.2025.123268](https://doi.org/10.1016/j.anbehav.2025.123268) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `jnlp-llama-mimi-ja.pdf` | 杉浦 一瑳 (Issa Sugiura). *Llama-Mimiが生まれるまで：はじめての音声言語モデル研究.* 自然言語処理 (Journal of Natural Language Processing) 33(3), 1731–1738 (2026). | [doi:10.5715/jnlp.33.1731](https://doi.org/10.5715/jnlp.33.1731) (J-STAGE) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `naca-tn-3241-scan.pdf` | Laurence K. Loftin, Jr. *Airfoil Section Characteristics at High Angles of Attack.* NACA Technical Note 3241 (1954). | [NTRS 19930083920](https://ntrs.nasa.gov/citations/19930083920) | Public domain: a US Government work. NTRS: "public use permitted" |
| `annotated.pdf` | `arxiv-cvpr-convnext.pdf` annotated by hand in macOS Preview (2026-11-20). | As for that paper | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The annotations are a change to the original |
| `hover-0.10-annotated.pdf` | `arxiv-cvpr-convnext.pdf` annotated and saved by Hover 0.10 (commit `578fbad`, through `@embedpdf/engines`), 2026-11-21. | As for that paper | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The annotations are a change to the original |

Elsevier blocks scripted downloads, so the two Elsevier files were saved
from a browser using "View PDF". Crossref lists CC BY 4.0 as the licence of
the version of record for both.

### What each paper covers

Notes on file structure, from pypdf and the current engine (`@embedpdf/pdfium`
2.15.0):

- **`arxiv-acl-adaptive-retrieval.pdf`**: 19 pages, A4, pdfTeX 1.40.25.
  Type 1 fonts (Nimbus Roman, CM, SFTT) **with** ToUnicode. 151 named
  destinations and 96 URI links. No outline.
- **`arxiv-cvpr-convnext.pdf`**: 15 pages, letter, pdfTeX 1.40.21. Type 1 CM
  and Nimbus fonts **without** ToUnicode, so Unicode comes from the font
  encodings, ligatures included. 172 named destinations and 13 URI links. No
  outline.
- **`ncomms-oxide-ion-conduction.pdf`**: 11 pages, Springer (iText 5.5).
  Bare-CFF fonts typeset with Advent 3B2 (`AdvOT…`, `AdvMacMthSyN`): about
  half have no ToUnicode, and two are CID-keyed. Has an outline. 110 named
  destinations and 51 URI links. The title contains δ-style chemical
  notation.
- **`elsevier-jphon-alutiiq-prosody.pdf`**: 22 pages, Acrobat DC. Advent 3B2
  fonts again (`AdvTT…`, `AdvPSSym`, `AdvCYRIL`): 25 Type 1 fonts with no
  ToUnicode and 4 TrueType fonts with no ToUnicode. Has IPA transcription.
  Outline, 251 named destinations and 185 URI links.
- **`elsevier-anbehav-wolves-dogs.pdf`**: 13 pages, PDFlib+PDI 10. A different
  Elsevier pipeline: Gulliver, Univers, STIX, ESSTIX and TeX CM, all with
  ToUnicode, plus CID TrueType. Outline, 214 named destinations and 111 URI
  links.
- **`annotated.pdf`**: Preview rewrites the whole file (one `%%EOF`, no
  incremental update) and leaves the pdfTeX producer in place. It holds six
  annotations, all with `/AP`, `/T` (the macOS user name), `/M` and `/F`, and
  none with `/CA`. The current engine reads them all with opacity 1:
  - p1: a highlight (yellow, 3 quads);
  - p2: an underline (green, 7 quads) and a sticky note (`/Text`,
    `/Name /Comment`) placed under it;
  - p2: an ink annotation (red, one 322-point stroke, `/BS /W 2`), carrying
    Preview's private `/AAPL:AKExtras`, which includes a base64 bplist;
  - p3 to p4: one highlight across a page break, so two annotations with the
    same `/Contents`.

  Preview stores the **selected text** in a highlight's and an underline's
  `/Contents`. Hover reads `/Contents` as the comment.
- **`hover-0.10-annotated.pdf`**: what files saved by Hover before it owned
  its PDFium layer look like. Every annotation carries the engine's private
  `/EPDFCustom` and an `/NM`. A yellow highlight on p1 has the comment "Saved
  by Hover 0.10" in its `/Contents` and in a separate `/Text` note linked to
  it only through `/EPDFCustom`. Also on p1: a green underline. On p2: a red
  ink drawing that was turned 30° in Hover; the engine dropped the angle on
  write, so the file holds the unturned points and no angle. On p3 to p4: one
  blue highlight saved as two annotations with the same `/NM`.
- **`jnlp-llama-mimi-ja.pdf`**: 8 pages, dvipdfmx (pLaTeX). Mixes Japanese,
  Latin and maths. CID-keyed Ryumin and Gothic BBB fonts (`Identity-H`)
  **without** ToUnicode, so text comes from the Adobe-Japan1 ordering. It is
  **encrypted** with an owner password only: it opens without asking, but
  permissions are restricted. A real-world counterpart to the generated
  `encrypted-owner-only.pdf`. No outline.
- **`naca-tn-3241-scan.pdf`**: 11 pages. 1-bit CCITT G4 page scans from
  Acrobat PDFWriter 2.01. The OCR text is invisible (`3 Tr`) and placed
  under a **y-flipped** image matrix. Page sizes differ slightly on every
  page (614×795 to 630×806).

Not used, for the record: the Japanese Journal of Psychology (心理学研究,
typeset with Edian) has CID fonts that are **not embedded**, and the Japanese
Journal of Animal Psychology has InDesign files with no outline. Both would
make good fixtures, but J-STAGE shows no CC licence for either, so they can't
be committed.

## Generated (`generated/`)

Made by `python3 scripts/make_edge_pdfs.py`, which needs pypdf. The output is
deterministic. The pages are synthetic: a 72 pt grid, a blue border on the
drawn box, corner labels with their user-space coordinates, and a red arrow
pointing to the unrotated top. No third-party content.

| File | Contents | Current engine |
| ---- | -------- | -------------- |
| `rotated.pdf` | 6 letter pages with `/Rotate` 0, 90, 180, 270, −90, 450 | Opens. Sizes 612×792 and 792×612. −90 → 270, 450 → 90 |
| `boxes.pdf` | 1 CropBox inset · 2 MediaBox off origin · 3 CropBox past MediaBox · 4 CropBox + `/Rotate 90` · 5 A4 landscape · 6 MediaBox inherited from `/Pages` · 7 no `/Contents` | Opens. 468×648, 612×792, 612×792 (clipped), 576×468, 842×595, 612×792, 612×792 |
| `forms.pdf` | AcroForm: text field with `/AP`, checked checkbox with `/AP`, combo box without `/AP` (`/NeedAppearances true`), push button with `/AP` | Opens. 4 widgets. A render with `withAnnotations: false` draws **none** of them |
| `encrypted-user-password.pdf` | RC4-128. User password `hover-user`, owner password `hover-owner` | Fails without a password: `FPDF_ERR_PASSWORD` (4) |
| `encrypted-owner-only.pdf` | RC4-128, empty user password, no permissions granted | Opens without a password |
| `bad-startxref.pdf` | `rotated.pdf` with a wrong `startxref` offset | Opens: PDFium rebuilds the xref by scanning |
| `truncated.pdf` | The first 60% of `rotated.pdf` | Fails: `FPDF_ERR_FORMAT` (3) |
| `not-a-pdf.pdf` | An HTML "Page Not Found" page saved as `.pdf`, which is what a publisher serves for an unavailable PDF | Fails: `FPDF_ERR_FORMAT` (3) |

## SHA-256

```
d65990b220d8a870adfbecb658b3f2c6f7a0ffe70a0d7ba6b9dc6b23a71769d2  papers/annotated.pdf
475016e21d73ca7b0d4530eadc3f39d7a515e68d4e7dbd87e42814a031faf631  papers/hover-0.10-annotated.pdf
6de64bcf9b199ae034a09f7e3c407ee6eb0af2bb866335a33445cee95ba1ac38  papers/arxiv-acl-adaptive-retrieval.pdf
1fde2340370d0eb8045bda97fc94da7adb2a7abe8e6ded1a473d22475b945e1a  papers/arxiv-cvpr-convnext.pdf
64242d9054a33af7cf6fbc52cf35ca53c9037120a47279fe789ed8558b1f733b  papers/elsevier-anbehav-wolves-dogs.pdf
7aa532c63d1614887e172a6c773d7e16bbf5648ec791dfde211f031db1ef4966  papers/elsevier-jphon-alutiiq-prosody.pdf
51f0e82e49139450b9ae105baa6648f7e30ba0114d24e88643b238bcbc233ab8  papers/jnlp-llama-mimi-ja.pdf
4470c858581952c1ea3348350e8ad93fc22bf3ca01f2ab41d9f53bd20a8830f7  papers/naca-tn-3241-scan.pdf
263b8b32d945f3c8999bc1b9e6466baaf432948415cb0ec716715321da0551a8  papers/ncomms-oxide-ion-conduction.pdf
```
