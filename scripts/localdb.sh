#!/bin/sh
# Start/stop the local PostgreSQL used for development on this Mac (installed in ~/.local/pgsql).
#   npm run db:start   |   npm run db:stop   |   npm run db:status
PGBIN="${PGBIN:-$HOME/.local/pgsql/bin}"
PGDATA="${PGDATA:-$HOME/.local/pgsql-data}"
case "$1" in
  start)  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$HOME/.local/pgsql-server.log" -w start ;;
  stop)   "$PGBIN/pg_ctl" -D "$PGDATA" -w stop ;;
  status) "$PGBIN/pg_ctl" -D "$PGDATA" status ;;
  *) echo "usage: $0 start|stop|status"; exit 1 ;;
esac
