# ProofBook — common tasks.
.PHONY: build build-prod build-mainnet test test-unit test-integration deploy-devnet clean

# Test/dev build (default features => mock-oracle adapter).
build:
	anchor build

# Production build: real TxLineAdapter targeting TxLINE devnet.
build-prod:
	anchor build -- --no-default-features

# Production build: real TxLineAdapter targeting TxLINE mainnet.
build-mainnet:
	anchor build -- --no-default-features --features mainnet

# Full test suite: Rust unit tests + TypeScript integration suite.
test: test-unit test-integration

# Rust unit tests (parimutuel payout math, fees, rounding/dust, overflow).
test-unit:
	cargo test -p proofbook --lib

# TypeScript integration suite against a fresh local validator (mock adapter).
test-integration:
	./scripts/test-integration.sh

# Same suite via Anchor's own runner on solana-test-validator (not surfpool).
test-anchor:
	anchor test --validator legacy

# Deploy proofbook to devnet (build the production binary first: `make build-prod`).
deploy-devnet:
	solana program deploy target/deploy/proofbook.so \
		--program-id target/deploy/proofbook-keypair.json \
		--url https://api.devnet.solana.com \
		--keypair $${SOLANA_KEYPAIR:-$$HOME/.config/solana/id.json}

clean:
	anchor clean
