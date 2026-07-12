import type { CategorySlug, DashboardData, Paper, PaperType } from "./types";

const topics: Record<CategorySlug, Array<[string, string, number, PaperType]>> = {
  "hep-th": [
    ["Infrared Consistency Relations for Open Quantum Fields in de Sitter", "de Sitter時空における開放量子場の赤外整合関係", 68, "理論"],
    ["Nonperturbative Dressed Observables in Asymptotically Flat Space", "漸近平坦時空における非摂動的ドレスト観測量", 64, "理論"],
    ["Entanglement Wedges in Non-AdS Holography", "非AdSホログラフィーにおけるエンタングルメント・ウェッジ", 62, "理論"],
    ["Bootstrap Bounds on Higher-Spin Thermal CFTs", "高スピン熱的CFTへのブートストラップ制限", 60, "解析"],
    ["Axion Defects after Low-Scale Reheating", "低スケール再加熱後のアクシオン欠陥", 58, "理論"],
    ["Quantum Error Correction from Operator Algebras", "作用素代数からみた量子誤り訂正", 57, "理論"],
    ["Effective Theory of Dissipative Inflationary Perturbations", "散逸的インフレーション摂動の有効理論", 55, "理論"],
    ["Celestial Amplitudes with Massive Memory", "質量を持つメモリー効果とセレスティアル振幅", 53, "理論"],
    ["Swampland Constraints in Multi-field Kination", "多場キネーションにおけるスワンプランド制限", 50, "解析"],
    ["A Primer on Relational Observables in Quantum Gravity", "量子重力における関係的観測量入門", 48, "レビュー"],
  ],
  "gr-qc": [
    ["Gauge-Invariant Influence Functionals for Constrained Gravitational Systems", "拘束された重力系のゲージ不変な影響汎関数", 66, "理論"],
    ["Ringdown Consistency Tests with O5 Observations", "O5観測によるリングダウン整合性検証", 64, "解析"],
    ["Third-Generation Forecasts for Tidal Resonances", "潮汐共鳴に対する第3世代検出器予測", 62, "解析"],
    ["Compact-Binary Formation Bias from GW–Galaxy Correlations", "重力波・銀河相関から探るコンパクト連星形成バイアス", 60, "解析"],
    ["Memory Signatures of Hyperbolic Encounters", "双曲遭遇におけるメモリー信号", 58, "理論"],
    ["Constraint-Preserving Numerical Relativity at Null Infinity", "ヌル無限遠で拘束を保存する数値相対論", 56, "解析"],
    ["Environmental Dephasing of LISA EMRIs", "LISA EMRIの環境誘起位相緩和", 55, "理論"],
    ["Fast Bayesian Maps for Stochastic Backgrounds", "確率的背景重力波の高速ベイズマップ", 53, "解析"],
    ["Scalarization in Rapidly Rotating Neutron Stars", "高速回転中性子星のスカラー化", 51, "理論"],
    ["Review of High-Frequency Gravitational-Wave Detection", "高周波重力波検出のレビュー", 49, "レビュー"],
  ],
  "quant-ph": [
    ["Distributed Quantum Sensing beyond Local Gaussian Measurements", "局所Gaussian測定を超える分散量子センシング", 65, "実験・観測"],
    ["Bosonic Error Correction under Correlated Loss", "相関損失下のボソニック誤り訂正", 64, "理論"],
    ["Nonclassicality Witnesses from Coarse-grained Homodyne Data", "粗視化ホモダインデータからの非古典性証人", 63, "解析"],
    ["Measurement-Induced Phases with Finite Feedback Delay", "有限フィードバック遅延を伴う測定誘起相", 61, "理論"],
    ["Fault-Tolerant Logical Gates in Neutral-Atom Arrays", "中性原子アレイにおける耐故障論理ゲート", 59, "実験・観測"],
    ["Resource Theory of Irreversible Decoherence", "不可逆デコヒーレンスのリソース理論", 57, "理論"],
    ["Quantum Metrology under Indefinite Causal Order", "不定因果順序下の量子計測", 55, "理論"],
    ["Scalable Tensor-Network Tomography", "スケーラブルなテンソルネットワーク・トモグラフィー", 53, "解析"],
    ["Benchmarks for Continuous-Variable Cloud Processors", "連続変数量子クラウドプロセッサのベンチマーク", 50, "実験・観測"],
    ["Tutorial on Quantum-Trajectory Methods", "量子軌道法のチュートリアル", 48, "レビュー"],
  ],
};

const authors: Record<CategorySlug, string[][]> = {
  "hep-th": [["A. Mori", "L. Chen", "M. Alvarez"], ["R. Singh", "E. Weber"], ["T. Nguyen", "K. Silva"], ["M. Ito", "P. Laurent"], ["N. Davis", "Y. Kim"], ["I. Novak", "C. Becker"], ["F. Rossi", "J. Park"], ["S. Khan", "D. Ruiz"], ["A. Olsen", "H. Tan"], ["M. Costa"]],
  "gr-qc": [["E. Rossi", "N. Kato", "D. Singh"], ["J. Martin", "R. Sato"], ["L. Evans", "P. Gupta"], ["K. Meyer", "A. Brown"], ["C. Wang", "T. Silva"], ["H. Lee", "M. Garcia"], ["N. Patel", "S. Ito"], ["F. Müller", "Y. Chen"], ["D. Wilson", "R. Kim"], ["A. Laurent", "J. Mori"]],
  "quant-ph": [["S. Laurent", "H. Yamane", "R. Patel"], ["M. Chen", "A. Smith"], ["K. Tanaka", "L. Rossi"], ["P. Miller", "N. Singh"], ["E. Garcia", "T. Wang"], ["R. Ito", "C. Davis"], ["J. Novak", "S. Kim"], ["Y. Weber", "F. Brown"], ["D. Park", "M. Evans"], ["A. Gupta", "H. Lee"]],
};

const scoreFor = (legacyTotal: number, index: number) => {
  const total = Math.round(legacyTotal * 1.25);
  const broadImpact = Math.max(8, Math.min(25, Math.round(total * 0.26)));
  const categoryImpact = Math.max(8, Math.min(25, Math.round(total * 0.27)));
  const originality = Math.max(8, Math.min(25, Math.round(total * (0.25 + (index % 2) * 0.01))));
  const technicalStrength = Math.max(8, Math.min(25, total - broadImpact - categoryImpact - originality));
  return { scores: { broadImpact, categoryImpact, originality, technicalStrength }, total };
};

function makePaper(category: CategorySlug, index: number): Paper {
  const [title, titleJa, legacyTotal, paperType] = topics[category][index];
  const scored = scoreFor(legacyTotal, index);
  const rank = index + 1;
  const shared = {
    "hep-th": {
      curiosity: "量子場の非摂動的・長距離構造を、対称性と観測可能量を保ったまま記述できるかが問題となる。既存の近似では、適用範囲やゲージ依存性が十分に整理されていない。",
      concept: "有効理論、整合関係、数値評価を組み合わせ、従来別々に扱われていた効果を単一の枠組みで比較する。解析極限と具体的模型の双方から結果の頑健性を検証する。",
      conclusion: "提案した枠組みが既知の極限を再現し、新しいパラメータ領域で非自明な補正を与えることを示す。一般の相互作用や観測量への拡張は未解決である。",
    },
    "gr-qc": {
      curiosity: "重力理論・重力波観測では、形式的整合性と実際に識別可能な効果を同時に評価する必要がある。従来手法では系統誤差や縮退が主要な制約となる。",
      concept: "ゲージ不変量または観測データに直接結びつく量を構成し、解析計算と数値・統計的評価を組み合わせて効果の大きさと識別可能性を調べる。",
      conclusion: "対象とする条件下で明確な特徴または制限を得たが、より現実的な雑音・環境・母集団を含む解析が必要であり、一般性は今後の検証課題である。",
    },
    "quant-ph": {
      curiosity: "量子資源が原理的な優位性を持っても、損失・粗視化・有限制御の下で観測可能な利得として残るとは限らない。実装可能性と資源の定義が課題となる。",
      concept: "明示的なプロトコルを構成し、古典戦略または標準的量子戦略と同一資源条件で比較する。解析的限界と数値または実験データから優位性を評価する。",
      conclusion: "限定された雑音領域で量子的優位性または新しい構造を確認した。スケーリング、校正誤差、より一般的なノイズ下での頑健性は未解決である。",
    },
  }[category];

  const firstAbstract: Record<CategorySlug, [string, string, string]> = {
    "hep-th": [
      "de Sitter上の開放量子場について、赤外発散と整合関係を同時に扱う実時間形式を構成した。",
      "Influence functionalに現れるsecular logarithmをWard恒等式に基づいて再編成した。",
      "確率的記述が成立する条件と、非局所的な環境相関によって破綻する領域を示した。",
    ],
    "gr-qc": [
      "First-class constraintを持つ線形重力系の縮約密度行列をBRST形式で定義した。",
      "ゲージ固定パラメータに依存しないinfluence functionalを、物理状態上で導出した。",
      "単純な重力デコヒーレンス模型で、非物理自由度をtrace outする問題を明確化した。",
    ],
    "quant-ph": [
      "分散量子センシングにおける非Gaussian共同測定を光学系で実装した。",
      "同一光子数の局所Gaussian戦略と比較し、位相推定誤差の低下を測定した。",
      "損失が一定値を超えると優位性が消失することも実験的に確認した。",
    ],
  };

  const abstractLines: [string, string, string] = index === 0
    ? firstAbstract[category]
    : [
        `${titleJa}を扱う理論的・数値的枠組みを提示した。`,
        "基準となる既存手法と同一条件で比較し、主要なパラメータ依存性を評価した。",
        "新しい効果が現れる領域と、近似または観測上の限界を明確にした。",
      ];

  return {
    rank,
    arxivId: `DEMO-${category}-${String(rank).padStart(2, "0")}`,
    url: "",
    title,
    titleJa,
    authors: authors[category][index],
    primaryCategory: category,
    paperType,
    scores: scored.scores,
    totalScore: scored.total,
    abstractLines,
    curiosity: shared.curiosity,
    concept: shared.concept,
    conclusion: shared.conclusion,
    assessment: `総合点${scored.total}/100。全体的重要度、${category}内での寄与、独創性、要旨から確認できる論証・検証の強さを分けて評価した。著者の知名度は点数に含めない。デモ表示のため、この評定は実在論文に対するものではない。`,
    fullTextEvaluated: false,
    evaluationBasis: "title_authors_abstract",
  };
}

function isoJst(date: Date) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replace(" ", "T") + "+09:00";
}

function recentDates(baseDate: string) {
  const dates: string[] = [];
  const cursor = new Date(`${baseDate}T12:00:00+09:00`);
  while (dates.length < 8) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return dates;
}

export function getDemoDashboard(requestedDate?: string | null): DashboardData {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
  const date = requestedDate || today;
  const now = isoJst(new Date());
  const categories = Object.fromEntries(
    (["hep-th", "gr-qc", "quant-ph"] as const).map((slug, categoryIndex) => {
      const topPapers = topics[slug].map((_, index) => makePaper(slug, index));
      const otherPapers = Array.from({ length: 6 }, (_, index) => ({
        rank: index + 11,
        arxivId: `DEMO-${slug}-${String(index + 11).padStart(2, "0")}`,
        url: "",
        title: `${["Finite-Resolution", "Boundary", "Nonlinear", "Robust", "Covariant", "Data-Driven"][index]} Studies in ${slug}`,
        authors: [["K. Arai", "M. Bell"], ["S. Cho"], ["J. Díaz", "L. Evans"], ["P. Fischer", "R. Gupta"], ["H. Inoue"], ["N. Jones", "T. Kaur"]][index],
        paperType: (["理論", "解析", "理論", "実験・観測", "解析", "レビュー"] as PaperType[])[index],
        totalScore: Math.round((46 - index - categoryIndex) * 1.25),
      }));
      return [slug, {
        slug,
        label: slug,
        totalNew: 28 + categoryIndex * 9,
        crosslistsExcluded: 4 + categoryIndex,
        evaluatedCount: 16,
        eminentAuthorPaperCount: 0,
        topPapers,
        otherPapers,
      }];
    }),
  ) as DashboardData["categories"];

  return {
    schemaVersion: "1.2",
    sourceMode: "demo",
    date,
    status: "ok",
    statusMessage: "画面確認用の架空データを表示中。実在論文の評価ではありません。",
    generatedAtJst: now,
    lastSuccessfulAtJst: now,
    availableDates: recentDates(today),
    categories,
  };
}
