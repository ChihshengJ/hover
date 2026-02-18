/**
 * Bit flags for citation metadata storage
 * Use bitwise operations: flags |= CitationFlags.NATIVE_CONFIRMED
 * Check with: (flags & CitationFlags.NATIVE_CONFIRMED) !== 0
 */
export const CitationFlags = Object.freeze({
  NONE: 0,
  NATIVE_CONFIRMED: 1 << 0, // Overlapped with native PDF annotation
  DEST_CONFIRMED: 1 << 1, // Native destination was validated
  RANGE_NOTATION: 1 << 2, // Original was range notation (e.g., [1-8], [17]-[19])
  MULTI_REF: 1 << 3, // References multiple items (e.g., [1,2,3])
  MULTI_YEAR: 1 << 4, // Single author with multiple years
});

/**
 * Cross-reference types enum
 */
export const CrossRefType = Object.freeze({
  FIGURE: "figure",
  TABLE: "table",
  SECTION: "section",
  EQUATION: "equation",
  ALGORITHM: "algorithm",
  THEOREM: "theorem",
  APPENDIX: "appendix",
});

// ============================================
// Common Section Names
// ============================================

/**
 * Common section names across academic disciplines
 * Organized for fast lookup using a Set
 */
export const COMMON_SECTION_NAMES = new Set([
  // === General Academic ===
  "abstract",
  "introduction",
  "background",
  "motivation",
  "overview",
  "summary",
  "conclusion",
  "conclusions",
  "concluding remarks",
  "acknowledgement",
  "acknowledgements",
  "acknowledgment",
  "acknowledgments",
  "references",
  "bibliography",
  "works cited",
  "appendix",
  "appendices",
  "supplementary",
  "supplementary material",
  "supplementary materials",
  "supplemental material",
  "supporting information",

  // === STEM - Methods ===
  "method",
  "methods",
  "methodology",
  "materials",
  "material and methods",
  "materials and methods",
  "material & methods",
  "materials & methods",
  "experimental",
  "experimental setup",
  "experimental design",
  "experimental methods",
  "experimental results",
  "experiment",
  "experiments",
  "procedure",
  "procedures",
  "approach",
  "technique",
  "techniques",
  "implementation",
  "system design",
  "system architecture",
  "architecture",
  "design",
  "setup",

  // === STEM - Results/Analysis ===
  "result",
  "results",
  "results and discussion",
  "findings",
  "finding",
  "analysis",
  "data",
  "data analysis",
  "observations",
  "measurements",
  "evaluation",
  "performance",
  "performance evaluation",
  "validation",
  "verification",
  "simulation",
  "simulations",
  "numerical results",
  "empirical results",
  "empirical analysis",

  // === STEM - Theory ===
  "theory",
  "theoretical background",
  "theoretical framework",
  "theoretical analysis",
  "model",
  "models",
  "modeling",
  "modelling",
  "formulation",
  "problem formulation",
  "problem statement",
  "problem definition",
  "preliminaries",
  "notation",
  "definitions",
  "framework",

  // === STEM - Literature ===
  "related work",
  "related works",
  "prior work",
  "previous work",
  "literature review",
  "literature survey",
  "state of the art",
  "review",
  "survey",

  // === STEM - Discussion ===
  "discussion",
  "discussions",
  "interpretation",
  "implications",
  "significance",
  "limitations",
  "limitation",
  "future work",
  "future works",
  "future directions",
  "future research",
  "open problems",
  "challenges",

  // === CS/Engineering Specific ===
  "algorithm",
  "algorithms",
  "proposed method",
  "proposed approach",
  "proposed system",
  "system overview",
  "case study",
  "case studies",
  "use case",
  "use cases",
  "application",
  "applications",
  "deployment",
  "scalability",
  "complexity",
  "complexity analysis",
  "proof",
  "proofs",
  "theorem",
  "lemma",
  "corollary",

  // === Medical/Biology ===
  "patients",
  "patient characteristics",
  "study population",
  "sample",
  "samples",
  "specimen",
  "specimens",
  "clinical",
  "clinical results",
  "clinical trial",
  "clinical trials",
  "treatment",
  "treatments",
  "outcome",
  "outcomes",
  "diagnosis",
  "prognosis",
  "etiology",
  "pathology",
  "pharmacology",
  "toxicology",
  "safety",
  "efficacy",
  "dosage",
  "side effects",
  "adverse effects",
  "statistical analysis",
  "ethics",
  "ethical considerations",
  "ethical approval",
  "informed consent",

  // === Physics/Chemistry ===
  "derivation",
  "calculation",
  "calculations",
  "synthesis",
  "characterization",
  "spectroscopy",
  "crystallography",
  "thermodynamics",
  "kinetics",
  "mechanism",
  "mechanisms",
  "reaction",
  "reactions",

  // === Social Sciences ===
  "research design",
  "research methodology",
  "research questions",
  "research question",
  "hypothesis",
  "hypotheses",
  "data collection",
  "sample size",
  "participants",
  "subjects",
  "interviews",
  "survey",
  "surveys",
  "questionnaire",
  "questionnaires",
  "qualitative analysis",
  "quantitative analysis",
  "mixed methods",
  "themes",
  "thematic analysis",
  "content analysis",
  "discourse analysis",
  "grounded theory",
  "ethnography",
  "phenomenology",
  "narrative",
  "narratives",
  "policy implications",
  "recommendations",
  "practical implications",
  "theoretical implications",
  "contribution",
  "contributions",
  "generalizability",
  "transferability",
  "validity",
  "reliability",
  "trustworthiness",

  // === History/Humanities ===
  "historiography",
  "sources",
  "primary sources",
  "secondary sources",
  "archival sources",
  "context",
  "historical context",
  "historical background",
  "argument",
  "thesis",
  "antithesis",
  "critique",
  "criticism",
  "commentary",
  "interpretation",
  "hermeneutics",
  "methodology",
  "periodization",
  "chronology",
  "evidence",
  "testimony",
  "biography",
  "prosopography",

  // === Economics/Business ===
  "market analysis",
  "economic analysis",
  "cost analysis",
  "cost-benefit analysis",
  "financial analysis",
  "regression",
  "regression analysis",
  "econometric analysis",
  "robustness",
  "robustness checks",
  "sensitivity analysis",
  "market",
  "markets",
  "industry",
  "competition",
  "strategy",
  "strategies",

  // === Law/Political Science ===
  "legal framework",
  "legal analysis",
  "jurisdiction",
  "legislation",
  "regulation",
  "regulations",
  "compliance",
  "governance",
  "policy",
  "policies",
  "political analysis",
  "comparative analysis",
  "international relations",
  "treaties",
  "conventions",

  // === Chinese (Simplified) ===
  "摘要",
  "引言",
  "导论",
  "绪论",
  "前言",
  "概述",
  "概要",
  "背景",
  "研究背景",
  "方法",
  "研究方法",
  "方法论",
  "材料",
  "材料与方法",
  "材料和方法",
  "实验",
  "实验方法",
  "实验设计",
  "实验结果",
  "实验部分",
  "试验",
  "结果",
  "研究结果",
  "结果与讨论",
  "结果与分析",
  "分析",
  "数据分析",
  "讨论",
  "讨论与分析",
  "结论",
  "结论与展望",
  "总结",
  "小结",
  "结语",
  "参考文献",
  "参考资料",
  "文献",
  "引用文献",
  "致谢",
  "鸣谢",
  "附录",
  "补充材料",
  "文献综述",
  "研究综述",
  "国内外研究现状",
  "理论框架",
  "理论基础",
  "理论分析",
  "模型",
  "模型构建",
  "算法",
  "算法设计",
  "系统设计",
  "系统架构",
  "研究设计",
  "研究问题",
  "研究假设",
  "假设",
  "假说",
  "数据收集",
  "数据来源",
  "样本",
  "样本选择",
  "案例分析",
  "案例研究",
  "实证分析",
  "实证研究",
  "定性分析",
  "定量分析",
  "统计分析",
  "回归分析",
  "相关工作",
  "相关研究",
  "研究现状",
  "国内外现状",
  "局限性",
  "研究局限",
  "不足",
  "未来工作",
  "未来研究",
  "展望",
  "研究展望",
  "建议",
  "对策建议",
  "政策建议",
  "启示",
  "意义",
  "研究意义",
  "贡献",
  "创新点",

  // === Chinese (Traditional) - common variants ===
  "緒論",
  "導論",
  "實驗",
  "結果",
  "結論",
  "討論",
  "參考文獻",
  "致謝",
  "附錄",
  "文獻綜述",
  "理論框架",
  "研究設計",
  "數據分析",
  "統計分析",
  "實證分析",
  "案例研究",
  "貢獻",
]);

/**
 * Pattern to strip leading section numbers
 * Matches: "1", "1.", "1.1", "1.1.1", "A.", "A.1", "I.", "II.", "(1)", "(a)", etc.
 */
export const SECTION_NUMBER_STRIP =
  /^(?:\d+(?:\.\d+)*\.?\s+|\(\d+\)\s*|[A-Z]\.(?:\d+(?:\.\d+)*\.?)?\s+|\([A-Za-z]\)\s*|[IVXLCDM]+\.\s+|\([IVXLCDM]+\)\s*)/;

// ============================================
// Reference Section Detection
// ============================================

/**
 * Patterns to identify the start of a reference section
 * Tested against line text after stripping section numbers
 */
export const REFERENCE_SECTION_PATTERN =
  /^(?:references?|references\+sand\+snotes\bibliography|works\s+cited|citations?|literature\s+cited|cited\s+literature|参考文献|參考文獻)$/i;

/**
 * Patterns that indicate the end of references (next section)
 * These sections typically follow references in academic papers
 */
export const POST_REFERENCE_SECTION_PATTERN =
  /^(?:appendix|appendices|supplementary|supplemental|acknowledgements?|acknowledgments?|author\s+contributions?|conflicts?\s+of\s+interest|competing\s+interests?|data\s+availability|code\s+availability|contents|funding|author\s+information|additional\s+information|extended\s+data|supporting\s+information|content)$/i;

// ============================================
// Reference Format Detection
// ============================================

/**
 * Reference numbering formats - order matters for priority
 * Each pattern should match at the START of a reference entry
 */
export const REFERENCE_FORMAT_PATTERNS = {
  // [1] Author, Title...
  "numbered-bracket": /^\s*\[(\d+)\]\s*/,

  // (1) Author, Title...
  "numbered-paren": /^\s*\((\d+)\)\s*/,

  // 1. Author, Title...
  "numbered-dot": /^\s*(\d+)\.\s+/,

  // 1 Author, Title... (no punctuation, just number + space)
  "numbered-plain": /^\s*(\d+)\s+(?=[A-Z])/,
};

/**
 * Pattern to detect author-year format references
 * Matches: "Smith, J. (2020)" or "Smith J (2020)" at start
 */
export const AUTHOR_YEAR_START_PATTERN =
  /^[A-Z][a-z\u00C0-\u00FF]+(?:[,\s]+[A-Z]\.?\s*)+.*?\(?(19|20)\d{2}[a-z]?\)?/;

/**
 * Pattern to detect a year anywhere in text (for validation)
 */
export const YEAR_PATTERN = /\b(19|20)\d{2}[a-z]?\b/;

// ============================================
// Inline Citation Patterns (Body Text)
// ============================================

/**
 * Unicode-aware dash pattern for ranges
 * Matches: - (hyphen), – (en-dash), — (em-dash)
 */
export const DASH_PATTERN = /[-–—]/;

/**
 * Numeric citation patterns found in paper body
 * Updated with proper Unicode dash support
 */
export const INLINE_CITATION_PATTERNS = {
  /**
   * Bracket citations: [1], [1,2,3], [1-5], [1-3, 5, 7-9]
   * Captures the inner content for parsing
   * Uses Unicode-aware dash matching
   */
  numericBracket:
    /\[(\d+(?:\s*[-–—]\s*\d+)?(?:\s*[,;]\s*\d+(?:\s*[-–—]\s*\d+)?)*)\]/g,

  /**
   * Inter-bracket range: [17]-[19], [17]–[19], [17]—[19]
   * Matches range notation where each number is in its own bracket
   * Captures: group 1 = start number, group 2 = end number
   */
  interBracketRange: /\[(\d+)\]\s*[-–—]\s*\[(\d+)\]/g,

  /**
   * Abbreviated citations: [YYZS+23], [CHA21], [CHAN+21, ZZYD+24]
   * Common in CS papers (first letters of authors + year)
   */
  abbreviatedBracket:
    /\[([A-Z]{2,}(?:\+)?\d{2}(?:\s*[,;]\s*[A-Z]{2,}(?:\+)?\d{2})*)\]/g,

  /**
   * Superscript number pattern (for validation after font-size detection)
   * Actual superscript detection uses font metrics, this is for text validation
   */
  superscriptDigits: /^\d+$/,

  /**
   * Superscript citation pattern - matches single numbers, comma-separated lists,
   * and ranges that appear in superscript citation slices.
   * Examples: "1", "1,2,3", "1-3", "1,2-5,7", "1–3"
   * Applied AFTER stripping trailing punctuation/whitespace from slice content.
   */
  superscriptCitation:
    /^\d+(?:\s*[-\u2013\u2014]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-\u2013\u2014]\s*\d+)?)*$/,
};

// ============================================
// Author-Year Citation Building Blocks
// ============================================

/**
 * Modular building blocks for author-year citation patterns.
 * These are string fragments that can be composed into full patterns.
 * Using strings allows for easier reading, modification, and composition.
 */
export const AUTHOR_YEAR_BLOCKS = {
  // Single author surname (Unicode-aware, handles hyphenated and apostrophe names)
  // Examples: Smith, O'Brien, García-López, Müller, de Bruin
  authorSurname: `(?:(?:[Dd]e|[Vv]on|[Vv]an|[Dd]er|[Dd]en|[Ll]e|[Ll]a|[Dd]el|[Dd]os|[Dd]as|[Dd]i|[Dd]u)\\s+)?\\p{Lu}[\\p{L}\\p{M}'-]+`,

  // Et al. suffix (optional)
  etAl: `(?:\\s+et\\s+al\\.?)`,

  // "and" connector for two authors (includes various ampersand forms)
  andConnector: `(?:and|&|&amp;|＆)`,

  // Single year (with optional letter suffix for multiple papers same year)
  // Examples: 2020, 2020a, 2020b, 2009a,b
  year: `\\d{4}[a-z]?(?:,[a-z])*`,

  // Single year or year with letter suffix(es)
  // Note: Year ranges like "1996-2004" are NOT supported as they are rare edge cases
  // that represent a single reference, not a range of years
  yearOrRange: `\\d{4}[a-z]?(?:,[a-z])*`,

  // Multiple years separated by commas
  // Examples: 2008, 2013 or 2009a,b
  multipleYears: `\\d{4}[a-z]?(?:,[a-z])*(?:\\s*,\\s*\\d{4}[a-z]?(?:,[a-z])*)*`,

  // Prefix phrases that may appear before citations in parentheses
  prefixPhrases: `(?:e\\.g\\.,?|i\\.e\\.,?|see|see also|cf\\.|compare|inter alia:)\\s*`,

  pages: `(?:,\\s*\\d+(?:[–-]\\d+)?)?`,
};

/**
 * Composed patterns for author-year citations.
 * Built from AUTHOR_YEAR_BLOCKS for maintainability.
 */
export const AUTHOR_YEAR_PATTERNS = {
  /**
   * Two authors with year(s) OUTSIDE parentheses
   * Examples: Garza and Williamson (2001), Smith & Jones (2020, 2021)
   */
  twoAuthorsExternal: {
    pattern: new RegExp(
      `(${AUTHOR_YEAR_BLOCKS.authorSurname})` +
      `\\s+${AUTHOR_YEAR_BLOCKS.andConnector}\\s*` +
      `(${AUTHOR_YEAR_BLOCKS.authorSurname})` +
      `\\s*\\((${AUTHOR_YEAR_BLOCKS.multipleYears})` +
      `${AUTHOR_YEAR_BLOCKS.pages}\\)`,
      "gu",
    ),
    extractAuthor: (match) => match[1].trim(),
    extractSecondAuthor: (match) => match[2].trim(),
    extractYears: (match) => parseYearsFromString(match[3]),
    isTwoAuthor: true,
  },

  /**
   * Two authors inside parentheses: (Author1 and Author2, Year)
   * Examples: (Smith and Jones, 2020), (García & López, 2021)
   */
  twoAuthorsInternal: {
    pattern: new RegExp(
      `\\((?:${AUTHOR_YEAR_BLOCKS.prefixPhrases})?` +
      `(${AUTHOR_YEAR_BLOCKS.authorSurname})` +
      `\\s+${AUTHOR_YEAR_BLOCKS.andConnector}\\s+` +
      `(${AUTHOR_YEAR_BLOCKS.authorSurname})` +
      `\\s*,?\\s*(${AUTHOR_YEAR_BLOCKS.multipleYears})` +
      `${AUTHOR_YEAR_BLOCKS.pages}\\)`,
      "gu",
    ),
    extractAuthor: (match) => match[1].trim(),
    extractSecondAuthor: (match) => match[2].trim(),
    extractYears: (match) => parseYearsFromString(match[3]),
    isTwoAuthor: true,
  },

  /**
   * Single author with year(s) OUTSIDE parentheses, year(s) IN parentheses
   * Examples: Smith (2020), Smith et al. (2020), Müller (2019, 2020)
   */
  authorThenYear: {
    pattern: new RegExp(
      `(${AUTHOR_YEAR_BLOCKS.authorSurname}${AUTHOR_YEAR_BLOCKS.etAl}?)` +
      `,?\\s*\\((${AUTHOR_YEAR_BLOCKS.multipleYears})` +
      `${AUTHOR_YEAR_BLOCKS.pages}\\)`,
      "gu",
    ),
    extractAuthor: (match) => match[1].replace(/\s+et\s+al\.?/i, "").trim(),
    extractYears: (match) => parseYearsFromString(match[2]),
    isTwoAuthor: false,
  },

  /**
   * Single citation inside parentheses: (Author, Year) or (Author et al., Year)
   * Examples: (Smith, 2020), (Smith et al., 2020), (Müller, 2019, 2020)
   */
  parenAuthorYear: {
    pattern: new RegExp(
      `\\((?:${AUTHOR_YEAR_BLOCKS.prefixPhrases})?` +
      `(${AUTHOR_YEAR_BLOCKS.authorSurname}${AUTHOR_YEAR_BLOCKS.etAl}?)` +
      `\\s*,?\\s*(${AUTHOR_YEAR_BLOCKS.multipleYears})` +
      `${AUTHOR_YEAR_BLOCKS.pages}\\)`,
      "gu",
    ),
    extractAuthor: (match) => match[1].replace(/\s+et\s+al\.?/i, "").trim(),
    extractYears: (match) => parseYearsFromString(match[2]),
    isTwoAuthor: false,
  },
};

/**
 * Pattern to match large parenthetical citation blocks containing multiple citations.
 * These are semicolon-separated groups of author-year citations.
 *
 * Examples:
 * - (Abutalebi et al., 2008, 2013; de Bruin et al., 2014; Garbin et al., 2011)
 * - (see Smith, 2020; Jones et al., 2021)
 *
 * Strategy: Match the entire parenthetical block, then parse internally.
 */
export const PARENTHETICAL_CITATION_BLOCK = new RegExp(
  `\\(` +
  `(?:${AUTHOR_YEAR_BLOCKS.prefixPhrases})?` +
  // First citation chunk (required)
  `(?:${AUTHOR_YEAR_BLOCKS.authorSurname})` +
  `(?:\\s+${AUTHOR_YEAR_BLOCKS.andConnector}\\s+${AUTHOR_YEAR_BLOCKS.authorSurname})?` +
  `${AUTHOR_YEAR_BLOCKS.etAl}?` +
  `\\s*,?\\s*` +
  `${AUTHOR_YEAR_BLOCKS.multipleYears}` +
  `${AUTHOR_YEAR_BLOCKS.pages}` +
  // Additional semicolon-separated citations (zero or more)
  `(?:` +
  `\\s*;\\s*` +
  `(?:${AUTHOR_YEAR_BLOCKS.authorSurname})` +
  `(?:\\s+${AUTHOR_YEAR_BLOCKS.andConnector}\\s+${AUTHOR_YEAR_BLOCKS.authorSurname})?` +
  `${AUTHOR_YEAR_BLOCKS.etAl}?` +
  `\\s*,?\\s*` +
  `${AUTHOR_YEAR_BLOCKS.multipleYears}` +
  `${AUTHOR_YEAR_BLOCKS.pages}` +
  `)*` +
  `\\)`,
  "gu",
);

/**
 * Pattern to split a parenthetical block into individual citation chunks.
 * Used after matching PARENTHETICAL_CITATION_BLOCK.
 */
export const CITATION_CHUNK_SPLITTER = /\s*;\s*/;

/**
 * Pattern to parse a single citation chunk (author + years).
 * Used on each chunk after splitting by semicolon.
 *
 * Captures:
 * - Group 1: Full author part (including "et al." and second author if present)
 * - Group 2: First author surname
 * - Group 3: Second author surname (if two-author citation)
 * - Group 4: Years string
 */
export const CITATION_CHUNK_PARSER = new RegExp(
  `^\\s*` +
  `(?:${AUTHOR_YEAR_BLOCKS.prefixPhrases})?` +
  // Author part - capture the whole thing and components
  `(` +
  `(${AUTHOR_YEAR_BLOCKS.authorSurname})` +
  `(?:\\s+${AUTHOR_YEAR_BLOCKS.andConnector}\\s+(${AUTHOR_YEAR_BLOCKS.authorSurname}))?` +
  `${AUTHOR_YEAR_BLOCKS.etAl}?` +
  `)` +
  `\\s*,?\\s*` +
  // Years
  `(${AUTHOR_YEAR_BLOCKS.multipleYears})` +
  `${AUTHOR_YEAR_BLOCKS.pages}` +
  `\\s*$`,
  "u",
);

// ============================================
// Year Parsing Utilities
// ============================================

/**
 * Parse a year string that may contain multiple years.
 * Note: Year ranges like "1996-2004" are treated as single unusual year patterns,
 * not as ranges. This is intentional as such patterns are rare edge cases.
 *
 * @param {string} yearStr - String like "2020", "2020, 2021", "2009a,b"
 * @returns {Array<{year: string, isRange: boolean}>}
 */
export function parseYearsFromString(yearStr) {
  const results = [];

  // First, expand compact notation like "2009a,b" to "2009a, 2009b"
  const expanded = yearStr.replace(
    /(\d{4})([a-z])((?:,[a-z])+)/g,
    (match, year, firstLetter, rest) => {
      const letters = [firstLetter, ...rest.split(",").filter((l) => l)];
      return letters.map((l) => `${year}${l}`).join(", ");
    },
  );

  const parts = expanded.split(/\s*,\s*/);

  for (const part of parts) {
    const trimmed = part.trim();
    // Match year with optional letter suffix
    const yearMatch = trimmed.match(/^(\d{4}[a-z]?)$/);
    if (yearMatch) {
      results.push({
        year: yearMatch[1],
        isRange: false,
      });
    }
    // Note: Year ranges like "1996-2004" are ignored as they don't match
    // the expected single-year pattern. These are rare edge cases that
    // represent a single reference entry, not a range of years.
  }

  return results;
}

/**
 * Parse a citation chunk into structured data.
 *
 * @param {string} chunk - A single citation chunk like "Smith et al., 2020, 2021"
 * @returns {Object|null} Parsed citation or null if invalid
 */
export function parseCitationChunk(chunk) {
  const match = chunk.match(CITATION_CHUNK_PARSER);
  if (!match) return null;

  const fullAuthorPart = match[1];
  const firstAuthor = match[2];
  const secondAuthor = match[3] || null;
  const yearsStr = match[4];

  const hasEtAl = /\s+et\s+al\.?/i.test(fullAuthorPart);
  const years = parseYearsFromString(yearsStr);

  return {
    firstAuthor: firstAuthor.trim(),
    secondAuthor: secondAuthor?.trim() || null,
    hasEtAl,
    isTwoAuthor: !!secondAuthor,
    years,
    rawText: chunk,
  };
}

/**
 * Parse an entire parenthetical citation block into structured data.
 *
 * @param {string} block - Full parenthetical block like "(Smith, 2020; Jones et al., 2021)"
 * @returns {Array<Object>} Array of parsed citations
 */
export function parseParentheticalBlock(block) {
  // Remove outer parentheses
  let inner = block.trim();
  if (inner.startsWith("(")) inner = inner.slice(1);
  if (inner.endsWith(")")) inner = inner.slice(0, -1);

  // Remove prefix phrases
  inner = inner.replace(
    new RegExp(`^${AUTHOR_YEAR_BLOCKS.prefixPhrases}`, "i"),
    "",
  );

  // Split by semicolon and parse each chunk
  const chunks = inner.split(CITATION_CHUNK_SPLITTER);
  const results = [];

  for (const chunk of chunks) {
    const parsed = parseCitationChunk(chunk);
    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}

// ============================================
// Cross-Reference Patterns (In-text)
// ============================================

/**
 * Pattern to parse numeric indices from bracket citation content
 * Handles: "1", "1,2,3", "1-5", "1-3, 5, 7-9"
 */
export const NUMERIC_INDEX_RANGE_PATTERN = /(\d+)\s*[-–—]\s*(\d+)/;

/**
 * Patterns for detecting in-text cross-references (Figure X, Table Y, etc.)
 * These appear in the body text and reference other parts of the document
 */
export const CROSS_REFERENCE_PATTERNS = {
  // Figure 1, Fig. 1, Fig 1, Figs. 1-3, Figure 1a
  figure:
    /\b(?:Fig(?:ure|s)?\.?\s*)([A-Z]?\d+[a-z]?(?:\s*[-–—]\s*[A-Z]?\d+[a-z]?)?(?:\s*[,&]\s*[A-Z]?\d+[a-z]?)*)/gi,

  // Table 1, Tab. 1, Tables 1-3
  table:
    /\bTab(?:le|s)?\.?\s+([A-Z]?\d+[a-z]?(?:\s*[–—,-]\s*[A-Z]?\d+[a-z]?)*)/gi,

  // Section 1, Sec. 1.2, Sec 3, Section D.1, Sec. A.2 (in-text references, not headers)
  // Note: § symbol in headers is handled by SECTION_MARK_HEADER_PATTERN
  section: /\b(?:Sec(?:tion|s)?\.?\s*)((?:[A-Z]|\d+)(?:\.\d+)*)/gi,
  // §1, §1.2.3, §A.2, § D.1 (section mark - always a reference, never a header by itself)
  sectionMark: /§\s*((?:[A-Z]|\d+)(?:\.\d+)*)/gi,

  // Equation 1, Eq. 1, Eqs. 1-3, Eqn. (1)
  equation: /\b(?:Eq(?:uation|n|s)?\.?\s*)\(?(\d+(?:\.\d+)?)\)?/gi,

  // Algorithm 1, Alg. 1
  algorithm: /\b(?:Alg(?:orithm|s)?\.?\s*)(\d+)/gi,

  // Theorem 1, Lemma 2, Proposition 3, Corollary 4, Definition 5
  theorem:
    /\b(Theorem|Lemma|Proposition|Corollary|Definition)\s+(\d+(?:\.\d+)?)/gi,

  // Appendix A, Appendix B.1, App. C
  appendix: /\b(?:Appendix|App\.)\s+([A-Z](?:\.\d+)?)/gi,
};

// ============================================
// Cross-Reference Definition Patterns (Captions/Headers)
// ============================================

/**
 * Patterns for detecting actual figure/table/section definitions (captions)
 * These are used to find the TARGET locations that cross-references point to
 *
 * Key distinction from CROSS_REFERENCE_PATTERNS:
 * - These patterns look for DEFINITIONS (e.g., "Figure 1:" at start of a caption)
 * - CROSS_REFERENCE_PATTERNS look for MENTIONS in body text
 *
 * Usage: Check if match is at/near line start and has appropriate font styling
 */
export const CROSSREF_DEFINITION_PATTERNS = {
  // "Figure 1:" or "Figure 1." or "Fig. 1:" at line start (caption)
  figure: /^(?:Fig(?:ure)?\.?\s*)(\d+[a-z]?)\s*[:.]/i,

  // "Table 1:" or "Table 1." or "Tab. 1:" at line start (caption)
  table: /^(?:Tab(?:le)?\.?\s*)(\d+[a-z]?)\s*[:.]*/i,

  // "Algorithm 1:" or "Algorithm 1." (algorithm caption)
  algorithm: /^(?:Algorithm\.?\s*)(\d+)\s*[:.]/i,

  // "Theorem 1." or "Lemma 2." etc. (theorem-like environments)
  theorem:
    /^(Theorem|Lemma|Proposition|Corollary|Definition)\s+(\d+(?:\.\d+)?)\s*[:.]/i,

  // "§1" or "§1.2" at line start (section header with mark)
  // This is different from section references in body text
  sectionMark: /^§\s*(\d+(?:\.\d+)*)\s/,
};

/**
 * Pattern to detect section headers using § symbol
 * Used when scanning for actual section definition locations
 */
export const SECTION_MARK_HEADER_PATTERN = /^§\s*(\d+(?:\.\d+)*)\s+\S/;

// ============================================
// URL and External Link Patterns
// ============================================

/**
 * URL pattern for detecting external links in text
 * Matches http://, https://, and common URL formats
 */
export const URL_PATTERN =
  /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi;

/**
 * DOI pattern - Digital Object Identifier
 * Matches: doi:10.xxxx/xxxxx, https://doi.org/10.xxxx/xxxxx
 */
export const DOI_PATTERN =
  /(?:doi[:\s]*|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,}(?:\.\d+)*\/\S+)/gi;

// ============================================
// Author Name Parsing
// ============================================

/**
 * Common name suffixes to strip when matching
 */
export const NAME_SUFFIXES = /\s+(?:Jr\.?|Sr\.?|II|III|IV|PhD|MD|et\s+al\.?)$/i;

/**
 * Pattern to extract last name from various formats
 * Handles: "Smith, J.", "J. Smith", "Smith J", "Smith, John"
 */
export const LAST_NAME_PATTERNS = {
  // Smith, J. or Smith, John
  lastFirst:
    /^([A-Z\u00C0-\u00D6][a-z\u00E0-\u00FF]+(?:[-'][A-Z\u00C0-\u00D6][a-z\u00E0-\u00FF]+)?),/,

  // J. Smith or John Smith (last word is surname)
  firstLast:
    /([A-Z\u00C0-\u00D6][a-z\u00E0-\u00FF]+(?:[-'][A-Z\u00C0-\u00D6][a-z\u00E0-\u00FF]+)?)\s*(?:,|$|\()/,
};

/**
 * Pattern to extract initials
 */
export const INITIALS_PATTERN = /\b([A-Z])\.?\s*/g;

// ============================================
// Reference Entry Boundary Detection
// ============================================

/**
 * Minimum character length for a valid reference
 */
export const MIN_REFERENCE_LENGTH = 30;

/**
 * Maximum character length for a valid reference
 */
export const MAX_REFERENCE_LENGTH = 2000;

/**
 * Common reference ending patterns
 */
export const REFERENCE_ENDING_PATTERNS = {
  // DOI at end
  doi: /doi[:\s]+\S+\.?\s*$/i,

  // URL at end
  url: /https?:\/\/\S+\.?\s*$/i,

  // Page numbers at end: pp. 1-20, p. 5, 123-456
  pages: /(?:pp?\.\s*)?\d+\s*[-–—]\s*\d+\.?\s*$/,

  // Year in parentheses at end (some formats)
  yearEnd: /\(\d{4}[a-z]?\)\.?\s*$/,

  // Volume/issue at end: 15(3), Vol. 5
  volumeIssue: /\d+\s*\(\d+\)\.?\s*$/,
};

// ============================================
// Utility Functions
// ============================================

/**
 * Parse numeric indices from citation bracket content
 * Handles: "1", "1,2,3", "1-5", "1-3, 5, 7-9"
 *
 * @param {string} content - Inner bracket content (e.g., "1-3, 5, 7-9")
 * @returns {{indices: number[], ranges: Array<{start: number, end: number}>}}
 */
export function parseNumericCitationContent(content) {
  const indices = [];
  const ranges = [];
  const parts = content.split(/[,;]/);

  for (const part of parts) {
    const trimmed = part.trim();
    const rangeMatch = trimmed.match(NUMERIC_INDEX_RANGE_PATTERN);

    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);

      ranges.push({ start, end });

      // Sanity limit: max 30 refs in a range
      for (let i = start; i <= Math.min(end, start + 30); i++) {
        indices.push(i);
      }
    } else {
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num > 0 && num < 1000) {
        indices.push(num);
      }
    }
  }

  return { indices, ranges };
}

/**
 * Check if citation has range notation flag
 * @param {number} flags - Citation flags
 * @returns {boolean}
 */
export function hasRangeNotation(flags) {
  return (flags & CitationFlags.RANGE_NOTATION) !== 0;
}

/**
 * Check if citation was confirmed by native annotation
 * @param {number} flags - Citation flags
 * @returns {boolean}
 */
export function isNativeConfirmed(flags) {
  return (flags & CitationFlags.NATIVE_CONFIRMED) !== 0;
}

/**
 * Check if citation has multiple years for same author
 * @param {number} flags - Citation flags
 * @returns {boolean}
 */
export function hasMultipleYears(flags) {
  return (flags & CitationFlags.MULTI_YEAR) !== 0;
}

/**
 * Create a fresh regex instance (avoids lastIndex issues with global patterns)
 * @param {RegExp} pattern - Pattern to clone
 * @returns {RegExp}
 */
export function cloneRegex(pattern) {
  return new RegExp(pattern.source, pattern.flags);
}
