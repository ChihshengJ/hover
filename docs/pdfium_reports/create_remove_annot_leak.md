# Draft: annotation created and removed before saving stays in the saved file since 89660bafdb

For issues.chromium.org, component PDFium. Attach `annot_base.pdf` (in
this folder). Any one-page PDF works.

---

**Title:** FPDFPage_CreateAnnot then FPDFPage_RemoveAnnot leaves the
annotation, /Contents included, in FPDF_SaveAsCopy output since
"Store annotations as indirect objects in /Annots"

**Summary**

Since 89660bafdb ("Store annotations as indirect objects in /Annots",
Bug 584383499), `FPDFPage_CreateAnnot` makes the new annotation dictionary an
indirect object. `FPDFPage_RemoveAnnot` then removes only its reference from
`/Annots`. `FPDF_SaveAsCopy` still writes the object: the annotation, its
`/Contents` text, and its appearance stream.

No viewer shows it, since nothing refers to it. But text the user deleted is
still in the saved file. For an embedder that lets users write comments and
delete them before saving, that is a privacy problem. Before 89660bafdb the
dictionary sat inline in `/Annots`, so removing it removed it from the file.

The cause seems to be an asymmetry in `CPDF_Creator`. `WriteOldObjs()` skips
objects that `GetObjectsWithReferences()` can't reach, but `WriteNewObjs()`
writes every object created since load, reachable or not. The same thing
already happens to appearance streams replaced with `FPDFAnnot_SetAP`, from
before 89660bafdb: each replaced stream stays in the output.

**Steps to reproduce**

```c
FPDF_DOCUMENT doc = FPDF_LoadMemDocument(data, size, NULL);  // annot_base.pdf
FPDF_PAGE page = FPDF_LoadPage(doc, 0);
FPDF_ANNOTATION annot = FPDFPage_CreateAnnot(page, FPDF_ANNOT_HIGHLIGHT);
FPDFAnnot_SetStringValue(annot, "Contents", L"SECRET");  // UTF-16LE
FPDFPage_CloseAnnot(annot);
FPDFPage_RemoveAnnot(page, FPDFPage_GetAnnotCount(page) - 1);  // returns true; count is now 0
FPDF_SaveAsCopy(doc, &writer, FPDF_NO_INCREMENTAL);
// Search the written bytes for "SECRET".
```

**Results** (pdfium-binaries wasm builds)

| PDFium build | `RemoveAnnot` | Annot count after | Saved file contains `SECRET` |
| ------------ | ------------- | ----------------- | ---------------------------- |
| chromium/8100 | true | 0 | no |
| chromium/8152 | true | 0 | no |
| chromium/8165 | true | 0 | **yes** |

**Expected:** an annotation removed before saving is not in the output, as
before chromium/8165.

**Suggestions:** either
- have `FPDFPage_RemoveAnnot` delete the annotation's indirect object when
  nothing else refers to it, or
- have `WriteNewObjs()` apply the same reachability filter as
  `WriteOldObjs()`.

The second option also covers appearance streams replaced by
`FPDFAnnot_SetAP`.

**Range:** chromium/8152 (6688c576fd) is good; chromium/8165 (1f02bc7d90) is
bad; 89660bafdb is the change in that range that touches annotation creation.
