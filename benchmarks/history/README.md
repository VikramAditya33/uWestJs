# Benchmark History

This directory stores historical benchmark results for tracking performance over time.

## File Format

Files are named: `YYYY-MM-DD-{commit-hash}.json`

## File Contents

Each JSON file contains:
- `timestamp` - ISO 8601 timestamp
- `date` - Date in YYYY-MM-DD format
- `commit` - Git commit hash (short)
- `commitMessage` - Git commit message
- `branch` - Git branch name
- `nodeVersion` - Node.js version
- `platform` - Operating system
- `arch` - CPU architecture
- `results` - Array of benchmark results for all scenarios

## Usage

Historical data is automatically:
- Saved by CI/CD on main branch pushes
- Used for regression detection in PRs
- Compared against last 5 runs

See `../compare-history.js` for comparison logic.
