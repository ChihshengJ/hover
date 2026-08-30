/**
 * The pane surface the annotation layer draws on.
 *
 * Every component under `ui/annotation/` used to take the whole `ViewerPane`,
 * which made each of them impossible to construct without one, and turned the
 * pane into an ad-hoc event bus: `AnnotationManager` assigned
 * `pane.onAnnotationHover`, and `AnnotationSVGLayer` — a child the manager
 * itself constructs — read it back off the pane. This is the surface they
 * actually need; the handlers now travel parent-to-child directly.
 *
 * Declarations only: `ViewerPane#annotationHost()` builds the one instance.
 */

import type { PDFDocumentModel } from "../../model/doc.js";
import type { PageView } from "../../viewer/page.js";
import type { TextSelectionRecord } from "../../viewer/text_manager.js";

export interface AnnotationHost {
  doc: PDFDocumentModel;
  /** The transformed element overlays sit in. */
  getStage(): HTMLElement;
  getScroller(): HTMLElement;
  getPages(): PageView[];
  getHandMode(): boolean;
  /** The current text selection, one record per page it covers. */
  getSelection(): TextSelectionRecord[];
  /**
   * Hand the pane the annotation entry points, so code that only has a pane
   * (the drawing controller, the navigation tree) can reach them.
   */
  publishCallbacks(callbacks: PaneAnnotationCallbacks): void;
}

export interface PaneAnnotationCallbacks {
  onAnnotationHover(annotationId: string, isEntering: boolean): void;
  onAnnotationClick(annotationId: string): void;
  editAnnotationComment(annotationId: string): void;
  deleteAnnotationComment(annotationId: string): void;
  selectAnnotation(annotationId: string): void;
}
