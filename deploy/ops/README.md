# Ops helpers for the Austria server

- `ops-set-password.cjs` runs inside the production container and sets one account password with the
  application's own scrypt hashing. It also revokes every session of that account.
- `reset-password.sh` is the host wrapper. Install both on the server:

```
scp deploy/ops/ops-set-password.cjs coder:/home/dinda/coder-app/ops-set-password.cjs
scp deploy/ops/reset-password.sh   coder:/home/dinda/coder-app/reset-password.sh
ssh coder 'chmod +x /home/dinda/coder-app/reset-password.sh'
```

Usage: `/home/dinda/coder-app/reset-password.sh <email> "<new password>"`

The helper prints only the account and how many sessions were revoked, never the password.
