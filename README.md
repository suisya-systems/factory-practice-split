# factory-practice-split
Practice target app built by the L5 factory: a small bill-splitting API

## Running

`PORT=3000 DATA_DIR=./data npm start` (binds 127.0.0.1). `npm test` runs the tests.

## Behaviour decisions

- **Splitting**: an expense is divided equally among `beneficiaryIds`. The payer gets a share only if they are listed as a beneficiary (listing them is optional).
- **Remainders**: `amount % n` leftover yen go one each to the beneficiaries who have received the fewest leftover yen so far in the group; ties go by member join order. This is deterministic and reproducible. The per-member split is fixed when the expense is recorded and returned as `shares` (`{memberId: yen}`).
- **amount**: an integer from 1 to 1,000,000,000,000.
- **name**: required, trimmed, 1–100 chars; doesn't have to be unique. **description**: optional string (default `""`), up to 500 chars.
- **Settlement**: greedily matches the largest debtor with the largest creditor, giving at most members−1 transfers. Every amount is a positive integer; zero transfers are never returned. With no expenses, `transfers` is `[]`. Also returns `balances` (`[{memberId, balance}]`, positive means the member is owed money).
- **Status codes**: 201 for creates, 200 for reads. 400 for invalid JSON or validation errors, including a payer or beneficiary who isn't in the group and empty or duplicate `beneficiaryIds`. 404 for an unknown group, expense or route. 405 for the wrong method; 413 for a body over 1 MB.
- **Error body**: `{"error": {"code": "...", "message": "..."}}`.
- **Ordering**: members and expenses are listed in creation order. Lists are bare arrays with no pagination.
- **IDs**: UUID v4. Groups, members and expenses also have a `createdAt` timestamp. Nothing can be updated or deleted.
- **Persistence**: when `DATA_DIR` is set, data is saved to `$DATA_DIR/data.json` (written atomically).
