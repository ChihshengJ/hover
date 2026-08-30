/**
 * The document event vocabulary.
 *
 * `doc.notify()` used to take any string at all, and subscribers matched on
 * prefixes (`event.startsWith("annotation-")`). That works right up until a
 * typo'd emitter silently reaches nobody, or a handler survives the removal of
 * the thing that emitted it — both of which had already happened here.
 *
 * Emitters and handlers name members of this object. Adding an event means
 * adding it here first, which is the point.
 */
export const DocEvent = Object.freeze({
  /** Background indexing finished; analysis results are available. */
  INDEX_READY: "index-ready",

  /** A single annotation was created. `{ annotation }` */
  ANNOTATION_ADDED: "annotation-added",
  /** A single annotation changed, comment included. `{ annotation }` */
  ANNOTATION_UPDATED: "annotation-updated",
  /** A single annotation was removed. `{ annotationId }` */
  ANNOTATION_DELETED: "annotation-deleted",
  /** A batch import replaced the annotation set. `{ annotations }` */
  ANNOTATIONS_IMPORTED: "annotations-imported",
});

export type DocEventName = (typeof DocEvent)[keyof typeof DocEvent];

/**
 * The annotation-scoped events, as a set — so a subscriber can ask "is this
 * mine?" without a prefix match on the string.
 */
export const ANNOTATION_EVENTS: ReadonlySet<DocEventName> = new Set([
  DocEvent.ANNOTATION_ADDED,
  DocEvent.ANNOTATION_UPDATED,
  DocEvent.ANNOTATION_DELETED,
  DocEvent.ANNOTATIONS_IMPORTED,
]);
