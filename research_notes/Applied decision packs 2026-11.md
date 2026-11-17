# Applied decision packs: source notes (2026-11-17)

These are sources for evaluation design and the scope of authored recipes, not endorsements
or validation of the resulting assistant-authored curriculum.

- [EvalPlus project](https://evalplus.github.io/): expanded executable test suites motivate
  checking correctness independently of the selecting model. Our authored pilot uses small
  finite suites and does not claim equivalent coverage to EvalPlus.
- [OpenAI's analysis of SWE-bench Verified](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/): reports both test/specification defects and contamination concerns.
  This motivates independently reviewing specifications and keeping naturally occurring fresh
  tasks separate from teaching data. It does not establish that our authored labels are correct.
- [Metamorphic testing of machine-learning applications](https://www.cs.columbia.edu/wp-content/uploads/sites/7/2016/08/Murphy-SEKE2008.pdf): relates controlled transformations to predictable
  output relationships. Deterministic floors can have exact invariants; model sensitivity
  requires measured, rather than assumed, invariance.
- [PCAOB AS 1105](https://pcaobus.org/oversight/standards/auditing-standards/details/AS1105): evidence relevance, reliability and provenance motivate distinguishing a document's claim
  from independent confirmation. The finance recipe checks draft evidence findings, not
  whether an audit complies with this standard. Operational requirements need the applicable
  version and a qualified practitioner.
- [CONSORT 2025](https://www.bmj.com/content/389/bmj-2024-081123): reporting guidance supports
  preserving study design, outcomes and the limits of supplied evidence. This is a reporting
  framework, not a causal-inference or clinical-decision oracle.
- [PRISMA 2020 checklist](https://www.prisma-statement.org/prisma-2020-checklist): explicit
  eligibility criteria and transparent selection records inform the medical research pack.
- [Cochrane study-selection standards C39-C42](https://www.cochrane.org/authors/handbooks-and-manuals/mecir-manual/standards-conduct-new-cochrane-intervention-reviews-c1-c75/performing-review-c24-c75/selecting-studies-include-review-c39-c42): final eligibility decisions use independent people with a predefined disagreement
  process; omitted outcome reporting alone must not silently become an exclusion rule.
  Consequently the recipe annotates records for review and never performs final exclusion.

The enterprise examples are hypothetical procurement policies, stated explicitly in their
inputs. They do not purport to encode a universal procurement or accounting standard.
