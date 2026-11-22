-- A paper close records signed net proceeds. A negative credit is a debit paid
-- to close the full defined-risk position.
alter table public.paper_trade_exits
  drop constraint if exists paper_trade_exits_exit_credit_check;
