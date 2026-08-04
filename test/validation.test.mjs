import assert from "node:assert/strict";
import test from "node:test";
import {
  CATEGORIES,
  comparePapers,
  findCategoryTemplateSkeletonIndices,
  findTotalScoreDistributionIssues,
  validateDate,
  validateJstTimestamp,
  validateModelPolicy,
  validateProductionReportSet,
} from "../scripts/lib/pipeline.mjs";
import { DATE, validPolicy, validReportSet } from "./helpers.mjs";

function rejectsMutation(mutator, pattern) {
  const reports = validReportSet();
  mutator(reports);
  assert.throws(() => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }), pattern);
}

function makeCategoryProseDiverse(reports) {
  for (const report of Object.values(reports)) {
    report.papers.forEach((paper, index) => {
      const number = index + 1;
      paper.abstractLines = [
        `固有の背景を示す論文第${number}要約一`,
        `固有の方法を示す論文第${number}要約二`,
        `固有の結果を示す論文第${number}要約三`,
      ];
      paper.curiosity = `固有の未解決課題を問う論文第${number}記述`;
      paper.concept = `固有の方法上の要点を示す論文第${number}項目`;
      paper.conclusion = `固有の主要結論と成立限界を示す論文第${number}記述`;
      paper.assessment = `固有の長所と主要な限界を比較する論文第${number}評価`;
      paper.scoreReasons = {
        broadImpact: `複数領域への波及経路を示す論文第${number}根拠`,
        categoryImpact: `主分野における前進を示す論文第${number}根拠`,
        originality: `既存手法との差分を示す論文第${number}根拠`,
        technicalStrength: `中心手法を支える検証を示す論文第${number}根拠`,
      };
      if (paper.fullTextEvaluated) {
        paper.fullTextReviewStatus = `固有の導出検証限界を確認した論文第${number}記録`;
      }
    });
  }
  return reports;
}

test("a complete production report set passes", () => {
  assert.doesNotThrow(() => validateProductionReportSet(validReportSet(), { date: DATE, policy: validPolicy() }));
});

test("a backfill report set accepts only consistent official pastweek listing URLs", () => {
  const reports = validReportSet();
  for (const slug of CATEGORIES) reports[slug].audit.listingUrl = `https://arxiv.org/list/${slug}/pastweek`;
  assert.doesNotThrow(() => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }));

  reports["hep-th"].audit.listingUrl = "https://arxiv.org/list/hep-th/new";
  assert.throws(
    () => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }),
    /same official listing kind/,
  );
});

test("model policy is enforceable without claiming benchmark qualification", () => {
  assert.doesNotThrow(() => validateModelPolicy(validPolicy()));
  const policy = validPolicy();
  policy.qualificationStatus = "qualified";
  assert.throws(() => validateModelPolicy(policy), /not_benchmarked/);
});

test("one exact historical run exception cannot authorize another date or run", () => {
  const reports = validReportSet();
  for (const report of Object.values(reports)) report.evaluationRun.reasoningEffort = "ultra";
  const policy = validPolicy();
  policy.historicalRunExceptions = [{
    runId: "run-2099-01-05-fixture",
    reportDate: DATE,
    reasoningEffort: "ultra",
    maximumFullTextEvaluated: { "quant-ph": 12, "gr-qc": 12, "hep-th": 12 },
    reason: "A completed pre-cap fixture is preserved without changing its provenance.",
  }];
  assert.doesNotThrow(() => validateProductionReportSet(reports, { date: DATE, policy }));

  policy.historicalRunExceptions[0].reportDate = "2099-01-06";
  assert.throws(() => validateProductionReportSet(reports, { date: DATE, policy }), /reasoningEffort.*must be high/);
});

test("invalid schema is rejected", () => {
  rejectsMutation((reports) => { reports["hep-th"].schemaVersion = "1.2"; }, /schemaVersion/);
});

test("invalid and mismatched dates are rejected", () => {
  assert.throws(() => validateDate("2099-02-30"), /real calendar date/);
  rejectsMutation((reports) => { reports["gr-qc"].reportDate = "2099-01-06"; }, /reportDate/);
  rejectsMutation((reports) => { reports["quant-ph"].audit.announcementDate = "2099-01-06"; }, /announcementDate/);
});

test("JST timestamps accept seconds or three-digit milliseconds and reject other offsets", () => {
  assert.equal(validateJstTimestamp("2099-01-05T12:34:56+09:00", "timestamp"), "2099-01-05T12:34:56+09:00");
  assert.equal(validateJstTimestamp("2099-01-05T12:34:56.789+09:00", "timestamp"), "2099-01-05T12:34:56.789+09:00");
  assert.throws(() => validateJstTimestamp("2099-01-05T03:34:56Z", "timestamp"), /optional milliseconds/);
  assert.throws(() => validateJstTimestamp("2099-01-05T12:34:56.78+09:00", "timestamp"), /optional milliseconds/);
});

test("incomplete audit is rejected", () => {
  rejectsMutation((reports) => { reports["hep-th"].audit.listingUrl = "https://example.test/new"; }, /listingUrl/);
  rejectsMutation((reports) => { reports["hep-th"].audit.sourceCounts.newPrimary -= 1; }, /newPrimary/);
});

test("invalid IDs and URLs are rejected", () => {
  rejectsMutation((reports) => { reports["hep-th"].papers[0].arxivId += "v1"; }, /arxivId/);
  rejectsMutation((reports) => { reports["gr-qc"].papers[0].url = "http://arxiv.org/abs/9901.00101"; }, /\.url/);
  rejectsMutation((reports) => { reports["quant-ph"].papers[0].arxivVersion = "v2"; }, /arxivVersion/);
  rejectsMutation((reports) => { reports["quant-ph"].papers[0].submissionType = "cross"; }, /submissionType/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].sourceUrls.push("https://example.com/untrusted"); }, /exactly the version-fixed arXiv/);
});

test("invalid score shape, range, and total are rejected", () => {
  rejectsMutation((reports) => { reports["hep-th"].papers[0].scores.citations = 25; }, /exactly/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].scores.broadImpact = 26; }, /0 through 25/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].totalScore -= 1; }, /four-score sum/);
});

test("schema 1.4 requires exact Japanese score reasons and the stable rubric marker", () => {
  rejectsMutation((reports) => { delete reports["hep-th"].papers[0].scoreReasons.originality; }, /scoreReasons.*exactly/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].scoreReasons.originality = "English only"; }, /natural Japanese/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].scoreReasons.broadImpact = "主題の分野横断的な射程を評価。";
  }, /generic rationale phrase|missing sahen inflection/);
  for (const phrase of [
    "従来の到達点と異なる具体的な差分は、固有の方法を導入した。",
    "固有の成果を得た。波及先はこの成果が直接扱う対象と隣接する理論・実装課題である。",
    "固有の方法を構成した。本文の主要節で成立条件を確認した。",
  ]) {
    rejectsMutation((reports) => {
      reports["hep-th"].papers[0].scoreReasons.originality = phrase;
    }, /generic rationale phrase/);
  }
  rejectsMutation((reports) => { reports["hep-th"].audit.scoreRubric = "四つの軸を採点する。"; }, /Daily arXiv rubric 3\.0/);
});

test("schema 1.4 score reasons describe paper evidence rather than evaluator provenance", () => {
  for (const phrase of [
    "公式v1本文で定理と数値検証を確認した。",
    "公式抄録で数値比較を確認したが、本文未確認である。",
    "数値比較はあるが、頑健性は要旨から確認できない。",
    "主定理と数値結果を確認したが、別模型での頑健性は未検証である。",
    "形式証明のインターフェース層を本文で追跡したが、全依存は未検証である。",
    "誤差解析は含むが、要旨上は新しい証明を主張しない。",
    "主定理は示されるが、独立再導出していない。",
  ]) {
    rejectsMutation((reports) => {
      reports["quant-ph"].papers[0].scoreReasons.technicalStrength = phrase;
    }, /evaluator review provenance/);
  }

  const accepted = validReportSet();
  accepted["quant-ph"].papers[0].fullTextReviewStatus = "公式v1本文で主定理と数値検証を確認し、独立再導出は行っていない。";
  assert.doesNotThrow(() => validateProductionReportSet(accepted, { date: DATE, policy: validPolicy() }));
});

test("schema 1.4 reader prose keeps review provenance in the dedicated status field", () => {
  rejectsMutation((reports) => {
    reports["quant-ph"].papers[0].conclusion = "主要結果は有望だが、頑健性は要旨から確認できない。";
  }, /paper content rather than evaluator review provenance/);
  rejectsMutation((reports) => {
    reports["quant-ph"].papers[0].assessment = "中心成果は有用である。ただし公式概要だけの評価であり、適用域は未確認である。";
  }, /paper content rather than evaluator review provenance/);
  rejectsMutation((reports) => {
    reports["quant-ph"].papers[0].abstractLines[2] = "主要結果を報告するが、誤差評価は本文未確認である。";
  }, /paper content rather than evaluator review provenance/);
  rejectsMutation((reports) => {
    reports["quant-ph"].papers[0].conclusion = "二つの指標は異なる応答を示すが、要旨の記述には解釈上の不整合が残る。";
  }, /paper content rather than evaluator review provenance/);
});

test("schema 1.4 rejects repeated reasons within a paper or across a category", () => {
  rejectsMutation((reports) => {
    const paper = reports["hep-th"].papers[0];
    paper.scoreReasons.originality = paper.scoreReasons.broadImpact;
  }, /four distinct per-axis reasons/);
  rejectsMutation((reports) => {
    const papers = reports["hep-th"].papers;
    for (let index = 1; index < 3; index += 1) {
      papers[index].scoreReasons.broadImpact = papers[0].scoreReasons.broadImpact;
    }
  }, /scoreReasons\.broadImpact.*maximum 25%/);
  rejectsMutation((reports) => {
    const papers = reports["hep-th"].papers;
    for (let index = 1; index < 3; index += 1) papers[index].assessment = papers[0].assessment;
  }, /assessment.*maximum 25%/);
  rejectsMutation((reports) => {
    const papers = reports["hep-th"].papers;
    for (let index = 1; index < 3; index += 1) papers[index].fullTextReviewStatus = papers[0].fullTextReviewStatus;
  }, /fullTextReviewStatus.*maximum 25%/);
});

test("schema 1.4 diversity limit is strictly greater than 25 percent", () => {
  const reports = validReportSet({ count: 12 });
  const papers = reports["hep-th"].papers;
  for (let index = 1; index < 3; index += 1) {
    papers[index].scoreReasons.broadImpact = papers[0].scoreReasons.broadImpact;
    papers[index].assessment = papers[0].assessment;
  }
  assert.doesNotThrow(() => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }));
});

test("schema 1.4 requires Japanese prose in every reader-facing evaluation field", () => {
  for (const field of ["titleJa", "paperType", "curiosity", "concept", "conclusion", "assessment"]) {
    rejectsMutation((reports) => { reports["hep-th"].papers[0][field] = "English only"; }, /natural Japanese/);
  }
  rejectsMutation((reports) => { reports["hep-th"].papers[0].abstractLines[1] = "English only"; }, /natural Japanese/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].titleJa = "量 QCD"; }, /at least 2/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].curiosity = "問いです。"; }, /at least 6/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].abstractLines[1] = "方法です。"; }, /at least 6/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].scoreReasons.originality = "根拠です。"; }, /at least 12/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].assessment = "評価です。"; }, /at least 12/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].fullTextReviewStatus = "English only"; }, /natural Japanese/);
});

test("schema 1.4 caps reader-facing prose to control recurring output usage", () => {
  rejectsMutation((reports) => {
    reports["quant-ph"].papers[0].assessment = "中心成果の価値と主要な制約を具体的に記述する。".repeat(20);
  }, /at most 160 characters/);
  rejectsMutation((reports) => {
    reports["gr-qc"].papers[0].abstractLines[0] = "対象となる物理問題と前提条件を説明する。".repeat(20);
  }, /at most 120 characters/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].scoreReasons.originality = "最も近い既存研究との差分と継承部分を具体的に説明する。".repeat(20);
  }, /at most 180 characters/);
});

test("schema 1.4 rejects untranslated lowercase English in Japanese evaluation prose", () => {
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].scoreReasons.broadImpact = "冷却原子でreservoir engineeringを用いて散逸を制御し、境界蓄積を検証した。";
  }, /lowercase English phrase/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].concept = "局所dephasingによる位相緩和を測定し、境界蓄積との関係を示した。";
  }, /lowercase English token/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].fullTextReviewStatus = "公式v1全文でnull行列の導出と数値検証を確認した。";
  }, /lowercase English token/);

  const accepted = validReportSet();
  accepted["hep-th"].papers[0].fullTextReviewStatus = "公式v1全文でbilby_glitchの実装とcoth(1)極限を確認した。";
  assert.doesNotThrow(() => validateProductionReportSet(accepted, { date: DATE, policy: validPolicy() }));
});

test("schema 1.4 translates general English terms while preserving proper names and standard abbreviations", () => {
  for (const phrase of [
    "depolarizing雑音",
    "truncated Wigner近似",
    "software実装",
    "quantum discordを用いた相関",
    "Rydberg blockadeを用いた制御",
    "qubitization手法",
    "rank-1射影",
    "polar CSS符号",
  ]) {
    rejectsMutation((reports) => {
      reports["quant-ph"].papers[0].concept = `${phrase}を中心手法として量子状態を解析する。`;
    }, /general English prose term/);
  }

  const accepted = validReportSet();
  accepted["quant-ph"].papers[0].paperType = "理論・CSS符号解析";
  accepted["quant-ph"].papers[0].concept = "Wigner関数とCSS符号をKerr時空のQNM解析に用いる。";
  assert.doesNotThrow(() => validateProductionReportSet(accepted, { date: DATE, policy: validPolicy() }));
});

test("schema 1.4 translates fit and echo when they are ordinary prose terms", () => {
  rejectsMutation((reports) => {
    reports["quant-ph"].papers[0].scoreReasons.technicalStrength =
      "三準位緩和fitと光子数校正により、検査中の緩和率と測定誤差を定量化した。";
  }, /general English prose term "fit"/);
  rejectsMutation((reports) => {
    reports["quant-ph"].papers[0].fullTextReviewStatus =
      "主要導出、Hahn echo、無作為化基準試験、検査誘起緩和を確認した。";
  }, /general English prose term "echo"/);

  const accepted = validReportSet();
  accepted["quant-ph"].papers[0].scoreReasons.technicalStrength =
    "三準位緩和のフィットと光子数校正により、検査中の緩和率と測定誤差を定量化した。";
  accepted["quant-ph"].papers[0].fullTextReviewStatus =
    "主要導出、Hahnエコー、無作為化基準試験、検査誘起緩和を確認した。";
  accepted["quant-ph"].papers[1].fullTextReviewStatus =
    "FIT法とECHO系列の較正手順を確認し、独立実装との一致範囲を精査した。";
  assert.doesNotThrow(() => validateProductionReportSet(accepted, { date: DATE, policy: validPolicy() }));
});

test("schema 1.4 rejects ASCII spaces at Japanese word boundaries", () => {
  rejectsMutation((reports) => {
    reports["gr-qc"].papers[0].concept = "全 相対論的 離心 波形を用いて環境効果を識別する。";
  }, /ASCII spaces at Japanese word boundaries/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].assessment = "de Sitter 時空での解析は有用だが、適用範囲が限られる。";
  }, /ASCII spaces at Japanese word boundaries/);
  rejectsMutation((reports) => {
    reports["quant-ph"].papers[0].scoreReasons.technicalStrength = "128 無秩序 シミュレーションと実験比較で中心主張を検証した。";
  }, /ASCII spaces at Japanese word boundaries/);

  const accepted = validReportSet();
  accepted["hep-th"].papers[0].concept = "de Sitter時空とStudent-t Monte Carlo誤差を同じ枠組みで解析する。";
  assert.doesNotThrow(() => validateProductionReportSet(accepted, { date: DATE, policy: validPolicy() }));
});

test("schema 1.4 rejects known literal or nonstandard Japanese phrases", () => {
  for (const phrase of [
    "一ループ",
    "模型切断",
    "技術的強度",
    "ブートストラップを回転させる",
    "無質量フェルミオンSchwinger対の電流",
    "ローレンツ時空スレッド",
  ]) {
    rejectsMutation((reports) => {
      reports["hep-th"].papers[0].assessment = `中心成果は${phrase}を含むが、適用範囲には制約が残る。`;
    }, /known unnatural Japanese phrase/);
  }
});

test("schema 1.4 rejects only high-confidence missing sahen inflections", () => {
  for (const phrase of [
    "有限系の応答を解析。",
    "理論予測と観測値を比較、適用範囲を評価した。",
    "主定理を証明；数値例で境界条件を検証した。",
  ]) {
    rejectsMutation((reports) => {
      reports["hep-th"].papers[0].concept = phrase;
    }, /missing sahen inflection/);
  }

  for (const phrase of [
    "有限系の応答を解析する。",
    "有限系の応答を解析し、既知極限と比較した。",
    "有限系の応答が解析され、境界条件も確認された。",
    "有限系の応答を解析している。",
  ]) {
    const accepted = validReportSet();
    accepted["hep-th"].papers[0].concept = phrase;
    assert.doesNotThrow(() => validateProductionReportSet(accepted, { date: DATE, policy: validPolicy() }));
  }

  const nominalLabels = validReportSet();
  nominalLabels["hep-th"].papers[0].paperType = "理論・数値解析";
  nominalLabels["hep-th"].papers[0].titleJa = "Kerr時空における数値解析";
  assert.doesNotThrow(() => validateProductionReportSet(nominalLabels, { date: DATE, policy: validPolicy() }));
});

test("schema 1.4 requires a Japanese display title rather than a mixed or repeated original", () => {
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].titleJa = reports["hep-th"].papers[0].title;
  }, /distinct from the original/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].titleJa = "macroscopic systemのquantum stochastic thermodynamics：algebraic approach";
  }, /general English title word|lowercase English token/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].titleJa = "量子systemの検証";
  }, /general English title word|lowercase English token/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].titleJa = "量子bootstrap検証";
  }, /general English title word|lowercase English token/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].titleJa = "Quantum Field Theoryの検証";
  }, /general English title word/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].titleJa = "量子gasの検証";
  }, /general English title word/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].titleJa = "Quantum-Fieldの検証";
  }, /general English title word/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].titleJa = `日本語題名：${reports["hep-th"].papers[0].title}`;
  }, /must not contain or concatenate the original title/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].titleJa = "日本語表示：Entropic Bell inequalities";
  }, /general English title word|lowercase English token/);

  const accepted = validReportSet();
  accepted["hep-th"].papers[0].titleJa = "KerrブラックホールにおけるQNMの検証";
  accepted["hep-th"].papers[1].titleJa = "LISAによるRényiダイバージェンスの測定";
  accepted["hep-th"].papers[2].titleJa = "QCD相図におけるYang–Mills理論";
  accepted["hep-th"].papers[3].titleJa = "Dark Energy Spectroscopic Instrumentによる宇宙観測";
  accepted["hep-th"].papers[4].titleJa = "非エルミート$\\mathcal{PT}$対称場の検証";
  accepted["hep-th"].papers[5].titleJa = "Schrödinger方程式の幾何学的解析";
  accepted["hep-th"].papers[6].titleJa = "Event Horizon TelescopeによるM87の観測";
  assert.doesNotThrow(() => validateProductionReportSet(accepted, { date: DATE, policy: validPolicy() }));
});

test("schema 1.4 assessment is narrative and never repeats numeric score summaries", () => {
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].assessment = "総合92/100。中心成果は有用だが、適用範囲は限定される。";
  }, /without repeating total or axis scores/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].assessment = "中心成果は有用である。独創性23/25：既存手法との差がある。";
  }, /without repeating total or axis scores/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].assessment = "総合評定は９２／１００。中心成果は有用だが、適用範囲は限定される。";
  }, /without repeating total or axis scores/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].assessment = "中心成果は有用である。技術的信頼性は23点で、適用範囲は限定される。";
  }, /without repeating total or axis scores/);
});

test("schema 1.4 assessment cannot repeat the title or use generic filler", () => {
  rejectsMutation((reports) => {
    const paper = reports["quant-ph"].papers[0];
    paper.assessment = `${paper.titleJa}に関する結果を報告する。点に価値があるが、本文を未確認のため、主張の頑健性は判断していない。`;
  }, /complete Japanese display title|generic rationale phrase/);
});

test("schema 1.4 rejects discovered batch templates in questions and assessments", () => {
  rejectsMutation((reports) => {
    reports["quant-ph"].papers[0].curiosity = "既存手法では届かなかった何を、どの仕組みで実現できるか。";
  }, /generic rationale phrase/);
  rejectsMutation((reports) => {
    reports["quant-ph"].papers[0].assessment = "要旨は対象に焦点を絞り、比較可能な問いへ具体化している。一方、誤差評価、条件依存性、既存法との差の全体は本文確認を要する。";
  }, /generic rationale phrase|paper content rather than evaluator review provenance/);
  rejectsMutation((reports) => {
    reports["quant-ph"].papers[0].assessment = "問題設定から中心手法、定量的または厳密な主結果までを結んだ点が強みである。一方、適用範囲は限定される。";
  }, /generic rationale phrase/);
});

test("schema 1.4 rejects a repeated question skeleton with paper-specific insertions", () => {
  const reports = validReportSet({ count: 20 });
  reports["quant-ph"].papers.forEach((paper, index) => {
    paper.curiosity = `論文${index + 1}の固有問題では到達しない量は何か、提案機構によって観測可能域をどこまで拡張できるか。`;
  });
  assert.throws(
    () => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }),
    /papers\.curiosity.*sentence skeleton/,
  );
});

test("schema 1.4 rejects repeated score-reason scaffolding around distinct claims", () => {
  const reports = validReportSet({ count: 20 });
  reports["quant-ph"].papers.forEach((paper, index) => {
    paper.scoreReasons.broadImpact = `論文${index + 1}の成果は固有領域との接点を持つが、異分野への効果は間接的である。一方、個別条件${index + 1}に依存する。この条件が主な制約である。`;
  });
  assert.throws(
    () => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }),
    /scoreReasons\.broadImpact.*sentence skeleton/,
  );
});

test("schema 1.4 rejects a category template skeleton hidden by lexical substitutions", () => {
  const reports = makeCategoryProseDiverse(validReportSet({ count: 20 }));
  const subjects = ["量子相関", "ブラックホール", "重力波", "位相転移", "量子補正", "宇宙膨張"];
  const targets = ["冷却原子", "Kerr時空", "LISA観測", "格子模型", "表面符号", "初期宇宙"];
  const limits = ["有限温度", "摂動展開", "低周波", "有限体積", "独立雑音", "等方性"];
  for (let index = 0; index < 6; index += 1) {
    reports["quant-ph"].papers[index].assessment =
      `${subjects[index]}は${targets[index]}へ応用できるが、${limits[index]}の仮定に依存する。`;
  }
  assert.throws(
    () => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }),
    /papers\.assessment.*category-level template skeleton for 6 of 20 papers/,
  );
});

test("schema 1.4 rejects a short template skeleton shared by most of a category", () => {
  const reports = makeCategoryProseDiverse(validReportSet({ count: 20 }));
  const subjects = [
    "量子相関", "重力波", "宇宙膨張", "位相転移", "量子補正", "熱輸送", "時空曲率",
    "境界応答", "誤差閾値", "粒子生成", "場強度", "光子統計", "真空崩壊",
  ];
  const limits = [
    "有限温度", "低周波", "初期条件", "有限体積", "独立雑音", "弱結合", "球対称性",
    "摂動領域", "局所模型", "断熱近似", "低密度", "短時間", "線形応答",
  ];
  for (let index = 0; index < subjects.length; index += 1) {
    reports["quant-ph"].papers[index].conclusion =
      `${subjects[index]}を示した。ただし、${limits[index]}に限られる。`;
  }
  assert.throws(
    () => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }),
    /papers\.conclusion.*category-level template skeleton for 13 of 20 papers.*shared short skeleton/,
  );
});

test("schema 1.4 checks template reuse within the full-text-reviewed subset", () => {
  const reports = makeCategoryProseDiverse(validReportSet({ count: 20 }));
  const reviewed = reports["quant-ph"].papers.filter((paper) => paper.fullTextEvaluated);
  reviewed.forEach((paper, index) => {
    paper.fullTextReviewStatus =
      `主要節${index + 1}の導出を確認した。ただし、独立検証${index + 1}は実施していない。`;
  });
  assert.equal(reviewed.length, 10);
  assert.throws(
    () => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }),
    /papers\.fullTextReviewStatus.*category-level template skeleton for 10 of 10 papers.*shared short skeleton/,
  );
});

test("schema 1.4 rejects abstract-line reuse disguised by connective substitutions", () => {
  const abstractLines = [
    "信号と同じHilbert空間で作用する雑音は検出不能誤りとして感度を損なう。",
    "次元を受動的に拡張し信号を傷つけず消失化できる必要十分条件を導いた。",
    "単一光子位相測定で変換可能重み0.5のPauli雑音下に標準量子限界を回復したが、条件を満たさない雑音成分は除去できない。",
  ];
  for (const [path, value] of [
    ["curiosity", "信号と同じHilbert空間で作用する雑音は検出不能誤りとして感度を損なうとき、支配条件は何か。"],
    ["concept", "次元を受動的に拡張し信号を傷つけず消失化できる必要十分条件を導いたことで、測定設計を整理した。"],
    ["conclusion", "単一光子位相測定で変換可能重み0.5のPauli雑音下に標準量子限界を回復した。ただし、条件を満たさない雑音成分は除去できない。"],
    ["assessment", "単一光子位相測定で変換可能重み0.5のPauli雑音下に標準量子限界を回復したことが主要な成果である一方、条件を満たさない雑音成分は除去できない。"],
    ["scoreReasons.broadImpact", "単一光子位相測定で変換可能重み0.5のPauli雑音下に標準量子限界を回復したため、量子計測への波及が見込まれる。条件を満たさない雑音成分は除去できない。"],
  ]) {
    rejectsMutation((reports) => {
      const paper = reports["quant-ph"].papers[0];
      paper.abstractLines = abstractLines;
      if (path.startsWith("scoreReasons.")) paper.scoreReasons.broadImpact = value;
      else paper[path] = value;
    }, /normalized trigram coverage/);
  }
});

test("the latest prose gates apply to daily reports starting on 2026-08-03", () => {
  function reportSet(date) {
    const reports = validReportSet({ date });
    const paper = reports["quant-ph"].papers[0];
    paper.abstractLines[2] =
      "単一光子位相測定で変換可能重み0.5のPauli雑音下に標準量子限界を回復したが、条件を満たさない雑音成分は除去できない。";
    paper.conclusion =
      "単一光子位相測定で変換可能重み0.5のPauli雑音下に標準量子限界を回復した。ただし、条件を満たさない雑音成分は除去できない。";
    return reports;
  }

  assert.doesNotThrow(() => validateProductionReportSet(reportSet("2026-08-02"), {
    date: "2026-08-02",
    policy: validPolicy(),
  }));
  assert.throws(() => validateProductionReportSet(reportSet("2026-08-03"), {
    date: "2026-08-03",
    policy: validPolicy(),
  }), /normalized trigram coverage/);
});

test("schema 1.4 abstract reuse check permits field-specific reasoning over shared terminology", () => {
  const reports = validReportSet();
  const paper = reports["quant-ph"].papers[0];
  paper.abstractLines = [
    "信号と同じHilbert空間で作用する雑音は検出不能誤りとして感度を損なう。",
    "次元を受動的に拡張し信号を傷つけず消失化できる必要十分条件を導いた。",
    "単一光子位相測定で標準量子限界を回復したが、変換不能成分は除去できない。",
  ];
  paper.curiosity = "量子センシングで信号と雑音を同時に変形せず、誤り位置だけを識別できる条件は何か。";
  paper.concept = "補助Hilbert空間への等長写像を用い、信号生成子を保存する雑音射影を構成する。";
  paper.conclusion = "消失化できる雑音部分では感度が回復する一方、直交条件を破る成分には別の訂正機構が要る。";
  paper.assessment = "必要十分条件と光学実証を結んだ点は強いが、改善幅は変換可能な雑音重みに支配される。";
  paper.scoreReasons.broadImpact = "雑音を位置既知誤りへ変える設計則は量子計測と誤り訂正を接続するが、対象は射影条件を満たす成分に限られる。";
  assert.doesNotThrow(() => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }));
});

test("schema 1.4 abstract reuse check counts repeated trigrams instead of treating them as a set", () => {
  const reports = validReportSet();
  const paper = reports["quant-ph"].papers[0];
  paper.abstractLines[0] = "量子相関量子相関量子相関量子相関量子相関量子相関量子相関量子相関を解析した。";
  paper.curiosity = "量子相関の実験で境界条件を変えたとき、識別可能性はどこまで保たれるか。";
  assert.doesNotThrow(() => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }));
});

test("category template check does not equate distinct prose merely because it contains ただし", () => {
  const values = [
    "ただし、有限温度では補正項が残る。",
    "結論は頑健である。ただし境界条件の変更は未検討である。",
    "観測量を再現したが、ただし低周波域には較正誤差がある。",
    "摂動論の範囲では成立する。ただし強結合極限へは外挿できない。",
    "主要な縮退を解いた。ただし、別の対称性を課す場合は追加解析を要する。",
    "数値収束を確認している。ただし格子間隔への依存性は残っている。",
    "予測値は一致した。ただし独立なデータ集合による検証は今後の課題である。",
    "誤差閾値を改善した。ただし、相関雑音を含む模型には直接適用できない。",
    "解析解が得られるのは球対称の場合である。ただし回転を弱く加えた展開も可能である。",
    "中心結果は初期条件に依存しない。ただし終状態の分類には追加仮定を用いる。",
    "測定回数を削減できる。ただし装置損失が大きい領域では優位性が消える。",
    "位相構造を特定した。ただし臨界点近傍の有限サイズ効果は分離していない。",
    "背景から信号を分離した。ただし、系統誤差の事前分布には感度がある。",
    "散乱振幅の極構造から共鳴幅を決定した。",
    "開放境界で保存則が破れる条件を演算子代数から導いた。",
    "二つの観測チャネルを同時適合し、縮退方向を制限した。",
    "非摂動解と数値発展を比較すると遷移時刻が一致した。",
    "補助モードを消去することで有効作用の局所項を分離した。",
    "長時間相関の減衰指数は初期状態の選択で変化した。",
    "検出効率を含む尤度を構成し、信頼区間の被覆率を評価した。",
  ];
  assert.equal(findCategoryTemplateSkeletonIndices(values, values.length), undefined);
});

test("schema 1.4 category template check permits common terminology with distinct grammar", () => {
  const reports = makeCategoryProseDiverse(validReportSet({ count: 20 }));
  const prose = [
    "量子相関を冷却原子で測定し、有限温度における減衰率を得た。",
    "Kerr時空の摂動方程式から、ブラックホールの応答を導いた。",
    "重力波の低周波成分はLISA観測へ接続するが、雑音模型に依存する。",
    "有限体積の格子模型では、位相転移の臨界指数が変化する。",
    "表面符号に独立雑音を加えると、量子補正の閾値が低下した。",
    "初期宇宙の等方性を仮定して、宇宙膨張の観測量を予測した。",
  ];
  prose.forEach((value, index) => { reports["quant-ph"].papers[index].assessment = value; });
  assert.doesNotThrow(() => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }));
});

test("schema 1.4 structural diversity permits shared terminology and exactly 25 percent reuse", () => {
  const reports = validReportSet({ count: 20 });
  for (const report of Object.values(reports)) {
    report.papers.forEach((paper, index) => {
      const number = index + 1;
      paper.abstractLines = [
        `量子エンタングルメントの背景を第${number}条件で整理した。`,
        `量子エンタングルメントの手法を第${number}設定で検証した。`,
        `量子エンタングルメントの結論を第${number}事例で示した。`,
      ];
      paper.curiosity = index < 5
        ? `第${number}の固有問題では到達しない量は何か、提案機構によって観測可能域をどこまで拡張できるか。`
        : `量子エンタングルメントの第${number}の問いを扱う。`;
      paper.concept = `量子エンタングルメントの第${number}の方法を構成する。`;
      paper.conclusion = `量子エンタングルメントの第${number}の帰結を得た。`;
      paper.scoreReasons = {
        broadImpact: `量子エンタングルメントの広い応用を第${number}条件で検証した。`,
        categoryImpact: `量子エンタングルメントの分野内効果を第${number}設定で示した。`,
        originality: `量子エンタングルメントの新規構成を第${number}事例で導入した。`,
        technicalStrength: `量子エンタングルメントの導出を第${number}検査で確認した。`,
      };
      paper.assessment = `量子エンタングルメントの証拠と限界を第${number}評価で比較した。`;
      if (paper.fullTextEvaluated) {
        paper.fullTextReviewStatus = `量子エンタングルメントの主要節を第${number}確認で精査した。`;
      }
    });
  }
  assert.doesNotThrow(() => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }));
});

test("schema 1.4 rejects duplicated summary sections, copied conclusions, and generic assessments", () => {
  rejectsMutation((reports) => {
    const paper = reports["hep-th"].papers[0];
    paper.abstractLines[0] = paper.curiosity;
  }, /must not (?:exactly duplicate|copy abstractLines\[0\] verbatim)/);
  rejectsMutation((reports) => {
    const paper = reports["hep-th"].papers[0];
    paper.assessment = `証拠を総合した。${paper.conclusion}`;
  }, /must not copy the conclusion/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].assessment = "物理的内容を確認し、分野内での重要度を評価した。";
  }, /generic rationale phrase/);
});

test("schema 1.4 rejects substantial verbatim reuse of abstract lines in evaluation fields", () => {
  const line0 = "有限温度量子系における長距離相関の成立条件と観測可能性を具体的に調べる。";
  const line1 = "対称性分解と数値対角化を組み合わせ、有限サイズ依存性と既知極限を比較する。";
  const line2 = "臨界近傍で新しい尺度則を得たが、非一様雑音を含む条件への適用は確立していない。";
  for (const [field, lineIndex] of [
    ["curiosity", 0],
    ["concept", 1],
    ["conclusion", 2],
    ["assessment", 2],
  ]) {
    rejectsMutation((reports) => {
      const paper = reports["hep-th"].papers[0];
      paper.abstractLines = [line0, line1, line2];
      paper[field] = `論文固有の説明として、${paper.abstractLines[lineIndex]}`;
    }, new RegExp(`must not copy abstractLines\\[${lineIndex}\\] verbatim`));
  }
  rejectsMutation((reports) => {
    const paper = reports["hep-th"].papers[0];
    paper.abstractLines = [line0, line1, line2];
    paper.scoreReasons.technicalStrength = `技術的根拠として、${line1}`;
  }, /scoreReasons\.technicalStrength.*must not copy abstractLines\[1\] verbatim/);
  rejectsMutation((reports) => {
    const paper = reports["hep-th"].papers[0];
    paper.abstractLines[1] = "対称性を用いて有限系の応答を解析した。";
    paper.concept = `方法の核として、${paper.abstractLines[1]}`;
  }, /concept.*must not copy abstractLines\[1\] verbatim/);
  rejectsMutation((reports) => {
    const paper = reports["hep-th"].papers[0];
    paper.scoreReasons.broadImpact = "有限温度で新しい尺度則を確認した。";
    paper.assessment = `総合すると、${paper.scoreReasons.broadImpact}一方で、非一様雑音への適用条件が主要な限界である。`;
  }, /assessment.*must not copy scoreReasons\.broadImpact verbatim/);
});

test("schema 1.4 rejects severe score plateaus instead of using arXiv IDs as the effective ranking", () => {
  const reports = validReportSet({ count: 20 });
  const papers = reports["quant-ph"].papers;
  for (let index = 0; index < 8; index += 1) {
    papers[index].scores = {
      broadImpact: 22,
      categoryImpact: 13,
      originality: 12,
      technicalStrength: 11,
    };
    papers[index].totalScore = 58;
  }
  papers.sort(comparePapers);
  papers.forEach((paper, index) => {
    paper.rank = index + 1;
  });
  assert.throws(
    () => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }),
    /must not assign one total score to 8 of 20 papers/,
  );
});

test("public-edition total-score guard can detect plateaus without four-axis details", () => {
  const papers = Array.from({ length: 20 }, (_, index) => ({ totalScore: 100 - index }));
  for (let index = 0; index < 8; index += 1) papers[index].totalScore = 58;
  assert.deepEqual(findTotalScoreDistributionIssues(papers), [{
    path: "totalScore",
    message: "must not assign one total score to 8 of 20 papers (maximum 35%)",
    paperIndices: [0, 1, 2, 3, 4, 5, 6, 7],
  }]);
});

test("historical schema 1.3 remains valid but cannot bypass new-publication checks", () => {
  const reports = validReportSet();
  for (const report of Object.values(reports)) {
    report.schemaVersion = "1.3";
    report.audit.scoreRubric = "Historical four-axis rubric.";
    for (const paper of report.papers) delete paper.scoreReasons;
  }
  const historical = reports["hep-th"].papers[0];
  historical.titleJa = "Historical English title";
  historical.abstractLines[0] = historical.curiosity;
  historical.assessment = `${historical.conclusion} 主題の分野横断的な射程を評価。`;
  assert.doesNotThrow(() => validateProductionReportSet(reports, {
    date: DATE,
    policy: validPolicy(),
    requiredSchema: "1.3",
  }));
  assert.throws(
    () => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }),
    /schemaVersion: must be 1\.4/,
  );
});

test("every final top-ten paper must be full-text reviewed", () => {
  rejectsMutation((reports) => {
    const paper = reports["quant-ph"].papers[9];
    paper.fullTextEvaluated = false;
    paper.evaluationBasis = "title_authors_abstract";
    delete paper.fullTextReviewStatus;
    paper.sourceUrls = [`${paper.url}v1`];
    paper.scores.technicalStrength = 17;
    paper.totalScore = Object.values(paper.scores).reduce((sum, value) => sum + value, 0);
    reports["quant-ph"].fullTextEvaluatedCount -= 1;
    reports["quant-ph"].audit.fullTextEvaluatedCount -= 1;
  }, /final top-10/);
});

test("rubric 3.0 caps scores that lack full-text evidence", () => {
  rejectsMutation((reports) => {
    const paper = reports["hep-th"].papers[10];
    paper.scores.broadImpact = 24;
    paper.totalScore = Object.values(paper.scores).reduce((sum, value) => sum + value, 0);
  }, /below 24 without full-text review/);
  rejectsMutation((reports) => {
    const paper = reports["hep-th"].papers[10];
    paper.scores.technicalStrength = 18;
    paper.totalScore = Object.values(paper.scores).reduce((sum, value) => sum + value, 0);
  }, /at most 17 without full-text review/);
});

test("Sol model identity and High reasoning effort are exact", () => {
  rejectsMutation((reports) => { reports["hep-th"].evaluationRun.modelId = "gpt-5.6-other"; }, /modelId/);
  rejectsMutation((reports) => { reports["hep-th"].evaluationRun.reasoningEffort = "ultra"; }, /reasoningEffort/);
  rejectsMutation((reports) => { reports["hep-th"].evaluationRun.modelSelectionVerified = false; }, /modelSelectionVerified/);
});

test("full-text reviews stay within the per-category resource budget", () => {
  rejectsMutation((reports) => {
    const report = reports["quant-ph"];
    report.papers = Array.from({ length: 13 }, (_, index) => {
      const source = structuredClone(report.papers[Math.min(index, report.papers.length - 1)]);
      source.arxivId = `9902.${String(index + 1).padStart(5, "0")}`;
      source.url = `https://arxiv.org/abs/${source.arxivId}`;
      source.rank = index + 1;
      source.scores = { broadImpact: 25 - index, categoryImpact: 20, originality: 20, technicalStrength: 20 };
      source.scoreReasons = {
        broadImpact: `候補${index + 1}の成果は、異なる物理領域へ届く具体的経路を持つ。`,
        categoryImpact: `候補${index + 1}は、量子物理の中心課題に対して固有の前進を示す。`,
        originality: `候補${index + 1}は、最も近い既存法から非自明な構成差を導入する。`,
        technicalStrength: `候補${index + 1}は、中心導出と独立検証に加えて適用限界を明記する。`,
      };
      source.totalScore = Object.values(source.scores).reduce((sum, value) => sum + value, 0);
      source.assessment = `候補${index + 1}の中心成果には明確な利点があるが、適用範囲には制約が残る。`;
      source.fullTextEvaluated = true;
      source.evaluationBasis = "full_text_major_sections";
      source.fullTextReviewStatus = `候補${index + 1}の主要節、検証、限界を確認した。`;
      source.sourceUrls = [
        `https://arxiv.org/abs/${source.arxivId}v1`,
        `https://arxiv.org/pdf/${source.arxivId}v1`,
      ];
      return source;
    });
    report.totalNew = 13;
    report.evaluatedCount = 13;
    report.fullTextEvaluatedCount = 13;
    report.audit.sourceCounts.newPrimary = 13;
    report.audit.sourceCounts.titleAuthorAbstractEvaluated = 13;
    report.audit.fullTextEvaluatedCount = 13;
  }, /resource-budget limit 12/);
});

test("all categories share one exact run and a run cannot be reused", () => {
  rejectsMutation((reports) => { reports["gr-qc"].evaluationRun.runId = "run-2099-01-05-other"; }, /identical evaluationRun/);
  assert.throws(() => validateProductionReportSet(validReportSet(), {
    date: DATE,
    policy: validPolicy(),
    existingRunIds: new Set(["run-2099-01-05-fixture"]),
  }), /already used/);
  assert.throws(() => validateProductionReportSet(validReportSet(), {
    date: DATE,
    policy: validPolicy(),
    expectedRunId: "run-2099-01-05-different",
  }), /must equal the host runId/);
});

test("equivalent run metadata is independent of JSON property order", () => {
  const reports = validReportSet();
  const run = reports["gr-qc"].evaluationRun;
  reports["gr-qc"].evaluationRun = {
    runId: run.runId,
    modelSelectionVerified: run.modelSelectionVerified,
    reasoningEffort: run.reasoningEffort,
    modelDisplayName: run.modelDisplayName,
    modelId: run.modelId,
  };
  assert.doesNotThrow(() => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }));
});

test("paper IDs cannot be duplicated within or across categories", () => {
  rejectsMutation((reports) => { reports["hep-th"].papers[1] = structuredClone(reports["hep-th"].papers[0]); }, /duplicated in this report/);
  rejectsMutation((reports) => {
    const source = reports["hep-th"].papers[0];
    const target = reports["gr-qc"].papers[0];
    target.arxivId = source.arxivId;
    target.url = source.url;
    target.sourceUrls = source.sourceUrls;
  }, /across categories/);
});

test("the report set has exactly the three configured categories", () => {
  const reports = validReportSet();
  reports.extra = reports[CATEGORIES[0]];
  assert.throws(() => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }), /exactly/);
});
