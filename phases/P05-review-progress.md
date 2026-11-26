# P05 review progress (scratch; reviewer)
Done (committed): 530ec77 waitlist stale-offer leak; d52d428 media JPEG trailing/between-scan metadata + streamed body limit + 422s.
Baseline gates before fixes: install/typecheck/lint OK; tests contracts 6, domain 284, member-pwa 126, admin-web 326, api 1041/1042 (scheduler-observability 5s timeout flake, passed on rerun).
TODO:
- DONE 4ca1955 backup scratch restore + streaming
- DONE 6465651 credits eligibility + refund key
- DONE fd71809+3c670ab ScanPass camera; DONE 0146347 PhotosSection
- DONE b5a1762 UI minors
- DONE f5429a4 media unlink after commit
- credits minors: refund idem key not checked against pack; others record only
- then: full gates, build, e2e, db:backup:verify, write P05-review.md + PR section
