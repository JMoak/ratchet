// Vocabulary

export {
  type AcceptancePlan,
  type AcceptanceResult,
  acceptanceSample,
  evaluateAcceptance,
  exactLowerBound,
  type ResolvedPlan,
  requiredActs,
  resolvePlan,
} from "./acceptance.ts";
// Compounding
export {
  agreement,
  type PoolMethod,
  type PoolOptions,
  pool,
  poolJudge,
  poolPick,
  poolRate,
  reliabilityWeight,
} from "./compound/aggregate.ts";
export {
  type CascadeDecision,
  type CascadeOptions,
  cascade,
  type Tier,
} from "./compound/cascade.ts";
export {
  type Attempt,
  type ChainOptions,
  type ChainResult,
  runChain,
  type Step,
  type StepTrace,
} from "./compound/chain.ts";
export {
  askOne,
  type CompoundDecision,
  isCompound,
  type Strategy,
  single,
} from "./compound/compound.ts";
export {
  compose,
  type EnsembleOptions,
  ensemble,
  identity,
  type Member,
  prefixState,
  reframe,
  replicate,
  shuffleOptions,
  type Transform,
} from "./compound/ensemble.ts";
export {
  batteryFeatures,
  fitLogistic,
  type LogisticModel,
  type LogisticOptions,
  poolLearned,
  predictLogistic,
} from "./compound/learned.ts";
export {
  type SequentialDecision,
  type SequentialOptions,
  sequential,
  voteLead,
} from "./compound/sequential.ts";
// Engine and gates
export {
  type Asker,
  type AskOptions,
  type AskResult,
  asStateLike,
  Engine,
  type EngineOptions,
  type QuestionReport,
  type Report,
  type ReportOptions,
  type StrategySpec,
  wasAnswered,
} from "./engine.ts";
export {
  allowIf,
  type BypassRule,
  bypassFor,
  type FloorRule,
  floorFor,
  forQuestion,
  oneWayDoor,
  refuseIf,
  reviewIf,
  reviewUnless,
} from "./floors.ts";
export {
  type Combiner,
  type Gate,
  type GateAskManyOptions,
  type GateAskOptions,
  type GateQuestion,
  type GateSpec,
  type GateVerdict,
  isBattery,
} from "./gate.ts";
export {
  brier,
  type Calibrator,
  type CostFit,
  type CoveragePoint,
  coverageAt,
  ece,
  errorCorrelation,
  expectedAccuracy,
  type FitMode,
  type FitOptions,
  type FittedThreshold,
  fitIsotonic,
  fitThreshold,
  fitThresholdByCost,
  isUnselected,
  pairwiseCorrelation,
  type ReliabilityBin,
  reliability,
  riskCoverage,
  type Scored,
  type ScoredTruth,
  scoredForYes,
  scoredFromLedger,
  scoredWithTruth,
  shadowAgreement,
  wilsonLower,
} from "./ledger/calibration.ts";
// Ledger and learning
export {
  type DecisionRecord,
  decisionRows,
  hashQuestion,
  hashState,
  inheritOutcome,
  isMemberOf,
  JsonlLedger,
  type Ledger,
  MemoryLedger,
  type Mode,
  newRequestId,
  type Outcome,
} from "./ledger/ledger.ts";
// Math worth exporting
export { effectiveN, majorityAccuracy, thresholdFromCosts } from "./math.ts";
export {
  LlmJsonOracle,
  type LlmJsonOracleOptions,
  labelsFor,
  RESPONSE_SCHEMA,
  renderQuestions,
} from "./oracles/llm-json.ts";
// Oracles
export {
  type CacheOptions,
  cached,
  failOpen,
  isFailedOpen,
  maxLatency,
  totalCost,
  withFallback,
  withTimeout,
} from "./oracles/oracle.ts";
export { judgeIf, RuleOracle, type VerdictRule } from "./oracles/rules.ts";
export { type SimConfig, SimOracle, type Truth, type TruthFn, truthTable } from "./oracles/sim.ts";
export {
  jev,
  jevViaOpenRouter,
  type SystemOneOptions,
  SystemOneOracle,
  toWire,
  type WireQuestion,
  type WireRequest,
  type WireResponse,
} from "./oracles/systemone.ts";
// Policy and floors
export {
  type GatePolicy,
  goProbability,
  hashPolicy,
  policyFromCosts,
  policyWithBand,
  type Ruling,
  rule,
} from "./policy.ts";
// Questions
export {
  judge,
  judgeVerdictFrom,
  LIMITS,
  neutralVerdict,
  pick,
  pickVerdictFrom,
  rate,
  rateVerdictFrom,
  shortlist,
  validateVerdict,
} from "./questions.ts";
// Recipes
export {
  type Band,
  band,
  compare,
  count,
  daysBetween,
  lines,
  pruneFields,
  relativeTime,
} from "./recipes/digest.ts";
export { Freshness, Hysteresis, type HysteresisOptions } from "./recipes/loop.ts";
export {
  type Chunk,
  type Doc,
  type Item,
  type Located,
  type LocateOptions,
  locate,
  locateWith,
  prune,
  type RecipeOptions,
  type Relevance,
  type RelevanceOptions,
  recipeAskOptions,
  recipeTag,
  relevance,
  type Screened,
  type ScreenOptions,
  screenMany,
} from "./recipes/screen.ts";
export { type Speculated, type SpeculateOptions, speculate } from "./recipes/speculate.ts";
export {
  type AuditWindow,
  Rollout,
  type RolloutCheckpoint,
  type RolloutEvidence,
  type RolloutOptions,
  type RolloutSettings,
  type RolloutStatus,
} from "./rollout.ts";
export {
  type DailyBudgetOptions,
  DailySpend,
  type Reservation,
  type SpendSnapshot,
} from "./spend.ts";
// State
export {
  type BuildOptions,
  DEFAULT_STATE_MAX_CHARS,
  type DigestValue,
  type FromRecordOptions,
  type PairOptions,
  State,
  StateBuilder,
  type StateEntry,
  type StateEntryKind,
  type UntrustedOptions,
} from "./state.ts";
export type {
  Action,
  DecideOptions,
  Decision,
  JudgeQuestion,
  JudgeVerdict,
  Oracle,
  PickQuestion,
  PickVerdict,
  Question,
  QuestionKind,
  RateQuestion,
  RateVerdict,
  StateInput,
  StateLike,
  Verdict,
  VerdictFor,
} from "./types.ts";
export { CAUTION, moreCautious } from "./types.ts";
