/**
 * The pane surface the annotation layer draws on.
 *
 * Every component under `ui/annotation/` used to take the whole `ViewerPane`,
 * which made each of them impossible to construct without one, and turned the
 * pane into an ad-hoc event bus: `AnnotationManager` assigned
 * `pane.onAnnotationHover`, and `AnnotationSVGLayer` — a child the manager
 * itself constructs — read it back off the pane. This typedef is the surface
 * they actually need, and the handlers now travel parent-to-child directly.
 *
 * @typedef {import('../../model/doc.js').PDFDocumentModel} PDFDocumentModel
 * @typedef {import('../../viewer/page.js').PageView} PageView
 *
 * @typedef {Object} AnnotationHost
 * @property {PDFDocumentModel} doc
 * @property {() => HTMLElement} getStage - the transformed element overlays sit in
 * @property {() => HTMLElement} getScroller
 * @property {() => PageView[]} getPages
 * @property {() => boolean} getHandMode
 * @property {() => Object|null} getSelection - current text selection, if any
 * @property {(callbacks: PaneAnnotationCallbacks) => void} publishCallbacks -
 *   hand the pane the annotation entry points, so code that only has a pane
 *   (the drawing controller, the navigation tree) can reach them
 *
 * @typedef {Object} PaneAnnotationCallbacks
 * @property {(annotationId: string, isEntering: boolean) => void} onAnnotationHover
 * @property {(annotationId: string) => void} onAnnotationClick
 * @property {(annotationId: string) => void} editAnnotationComment
 * @property {(annotationId: string) => void} deleteAnnotationComment
 * @property {(annotationId: string) => void} selectAnnotation
 */

export {};
