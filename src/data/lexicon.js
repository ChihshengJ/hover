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
  /^(?:references?|bibliography|works\s+cited|citations?|literature\s+cited|cited\s+literature)$/i;

/**
 * Patterns that indicate the end of references (next section)
 * These sections typically follow references in academic papers
 */
export const POST_REFERENCE_SECTION_PATTERN =
  /^(?:appendix|appendices|supplementary|supplemental|acknowledgements?|acknowledgments?|author\s+contributions?|conflicts?\s+of\s+interest|competing\s+interests?|data\s+availability|code\s+availability|contents|funding|author\s+information|additional\s+information|extended\s+data|supporting\s+information)/i;

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
  /^[A-Z][a-zÀ-ÿ]+(?:[,\s]+[A-Z]\.?\s*)+.*?\(?(19|20)\d{2}[a-z]?\)?/;

/**
 * Pattern to detect a year anywhere in text (for validation)
 */
export const YEAR_PATTERN = /\b(19|20)\d{2}[a-z]?\b/;

// ============================================
// Inline Citation Patterns
// ============================================

/**
 * Numeric citation patterns found in paper body
 */
export const NUMERIC_CITATION_PATTERNS = {
  // [1] or [1,2,3] or [1, 2, 3]
  bracketList: /\[(\d+(?:\s*[,;]\s*\d+)*)\]/g,

  // [1-5] or [1–5] or [1—5]
  bracketRange: /\[(\d+)\s*[-–—]\s*(\d+)\]/g,

  // [1-3, 5, 7-9] - mixed ranges and singles
  bracketMixed:
    /\[(\d+(?:\s*[-–—]\s*\d+)?(?:\s*[,;]\s*\d+(?:\s*[-–—]\s*\d+)?)*)\]/g,

  // Superscript numbers (detected via font size, but pattern for validation)
  superscript: /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g,
};

/**
 * Author-year citation patterns found in paper body
 */
export const AUTHOR_YEAR_CITATION_PATTERNS = {
  // Smith (2020) or Smith et al. (2020)
  authorThenYear: /([A-Z][a-zÀ-ÿ]+(?:\s+et\s+al\.?)?)\s*\((\d{4}[a-z]?)\)/g,

  // Smith and Jones (2020)
  twoAuthors:
    /([A-Z][a-zÀ-ÿ]+)\s+(?:and|&)\s+([A-Z][a-zÀ-ÿ]+)\s*\((\d{4}[a-z]?)\)/g,

  // (Smith, 2020) or (Smith & Jones, 2020)
  parenAuthorYear:
    /\(([A-Z][a-zÀ-ÿ]+(?:\s+(?:et\s+al\.?|and|&)\s+[A-Z][a-zÀ-ÿ]+)?),?\s*(\d{4}[a-z]?)\)/g,

  // (Smith, 2020; Jones, 2021) - multiple citations
  parenMultiple:
    /\(([A-Z][a-zÀ-ÿ]+.*?\d{4}[a-z]?(?:\s*[;,]\s*[A-Z][a-zÀ-ÿ]+.*?\d{4}[a-z]?)+)\)/g,
};

// ============================================
// Cross-Reference Patterns (Figures, Tables, etc.)
// ============================================

export const CROSS_REFERENCE_PATTERNS = {
  // Figure 1, Fig. 1, Fig 1, Figs. 1-3
  figure: /\b(?:Fig(?:ure|s)?\.?\s*)(\d+[a-z]?(?:\s*[-–—]\s*\d+[a-z]?)?)/gi,

  // Table 1, Tab. 1, Tables 1-3
  table: /\b(?:Tab(?:le|s)?\.?\s*)(\d+[a-z]?(?:\s*[-–—]\s*\d+[a-z]?)?)/gi,

  // Section 1, Sec. 1.2, §1, §1.2.3
  section: /\b(?:Sec(?:tion|s)?\.?\s*|§\s*)(\d+(?:\.\d+)*)/gi,

  // Equation 1, Eq. 1, Eqs. 1-3, Eqn. (1)
  equation: /\b(?:Eq(?:uation|n|s)?\.?\s*)\(?(\d+)\)?/gi,

  // Algorithm 1, Alg. 1
  algorithm: /\b(?:Alg(?:orithm|s)?\.?\s*)(\d+)/gi,

  // Theorem 1, Lemma 2, Proposition 3, Corollary 4
  theorem:
    /\b(Theorem|Lemma|Proposition|Corollary|Definition)\s+(\d+(?:\.\d+)?)/gi,

  // Appendix A, Appendix B.1
  appendix: /\b(?:Appendix|App\.)\s+([A-Z](?:\.\d+)?)/gi,
};

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
  lastFirst: /^([A-ZÀ-Ý][a-zà-ÿ]+(?:[-'][A-ZÀ-Ý][a-zà-ÿ]+)?),/,

  // J. Smith or John Smith (last word is surname)
  firstLast: /([A-ZÀ-Ý][a-zà-ÿ]+(?:[-'][A-ZÀ-Ý][a-zà-ÿ]+)?)\s*(?:,|$|\()/,
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
