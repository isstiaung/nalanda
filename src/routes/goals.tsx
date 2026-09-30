// Reading goals (ARCH.md §16 #49): each member's "N books in a year". Members set and change their own; an admin can
// set anyone's, checked here (403 with a reason) and again in the statement that writes (the Actor guards in
// src/db/queries.ts). What counts is worked out when a page asks — see goalCountSql.
import { Hono, type Context } from 'hono';
import type { FC } from 'hono/jsx';
import { deleteGoal, getGoal, getSiteSettings, getUserById, goalsOf, listPeople, setGoal, type GoalProgress } from '../db/queries';
import type { AppEnv } from '../env';
import { MAX_GOAL_TARGET, parseGoalTarget, settableYears } from '../lib/goals';
import { todayUtc } from '../lib/reads';
import { GoalMeter } from '../views/components';
import { page } from '../views/layout';

const goals = new Hono<AppEnv>();

const notYours = (c: Context<AppEnv>) => c.text('That reading goal is someone else’s: only they or an admin can change it.', 403);

type PageProps = {
  whose: { id: number; username: string };
  self: boolean;
  admin: boolean;
  people: Array<{ id: number; username: string }>;
  list: GoalProgress[];
  today: string;
  // connected households hear about this member's goals: connections are set up, names and goals both go to them, and
  // the member has a display name — without one their goals never go out (§16 #49)
  shared: boolean;
  error?: string;
  year?: number;
  target?: string;
};

const GoalsPage: FC<PageProps> = ({ whose, self, admin, people, list, today, shared, error, year, target }) => {
  const years = settableYears(today);
  const chosenYear = year ?? years[0]!;
  const current = list.find((g) => g.year === chosenYear);
  const query = self ? '' : `?member=${whose.id}`;
  return (
    <>
      <div class="page-head">
        <div>
          <h1>Reading goals</h1>
          <span class="sub">BOOKS FINISHED IN A YEAR</span>
        </div>
      </div>
      {admin && people.length > 1 ? (
        <form method="get" action="/goals" class="inline-form goal-member">
          <label>
            Member{' '}
            <select name="member">
              {people.map((p) => (
                <option value={String(p.id)} selected={p.id === whose.id}>
                  {p.username}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" class="btn">
            Show
          </button>
        </form>
      ) : null}
      <article class="panel form-card" id="goal-form">
        <p class="eyebrow">{self ? 'Your goal' : `${whose.username}’s goal`}</p>
        {error ? <p class="error" role="alert">{error}</p> : null}
        <form method="post" action={`/goals${query}`} class="goal-form">
          <input type="hidden" name="userId" value={String(whose.id)} />
          <label>
            Year
            <select name="year">
              {years.map((y) => (
                <option value={String(y)} selected={y === chosenYear}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label>
            Books
            <input
              type="number"
              name="target"
              min="1"
              max={String(MAX_GOAL_TARGET)}
              inputmode="numeric"
              required
              value={target ?? (current ? String(current.target) : '')}
            />
          </label>
          <button type="submit">Save goal</button>
        </form>
        <p class="muted form-note">
          Every book {self ? 'you finish' : 'they finish'} with an end date in that year counts, a re-read too. Records and
          board games don’t, and nor does a finish with no date. Setting a new number keeps the count.
          {shared
            ? ' Connected households following a view of your books see when a goal is set, passes halfway and is reached, signed with the display name — never which book or when it was read.'
            : ''}
        </p>
      </article>
      <section>
        <p class="eyebrow">{self ? 'Your goals' : `${whose.username}’s goals`}</p>
        {list.length ? (
          <ul class="goal-list">
            {list.map((g) => (
              <li>
                <div class="goal-year mono">{g.year}</div>
                <GoalMeter count={g.count} target={g.target} year={g.year} today={today} />
                <form method="post" action={`/goals/${g.id}/delete${query}`} class="inline" data-confirm={`Delete the ${g.year} goal?`}>
                  <button type="submit" class="btn">
                    Delete
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted">No goals yet.</p>
        )}
      </section>
    </>
  );
};

/** The member a page or a post is about: yourself, or — for an admin — anyone. Null for a member asking about another. */
function whoseGoals(c: Context<AppEnv>, raw: string | undefined): number | null {
  const user = c.get('user');
  if (raw === undefined || raw === '') return user.id;
  const id = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  if (id === user.id) return user.id;
  return user.role === 'admin' && Number.isSafeInteger(id) ? id : null;
}

async function render(c: Context<AppEnv>, memberId: number, extra: Pick<PageProps, 'error' | 'year' | 'target'> = {}, status: 200 | 400 = 200) {
  const user = c.get('user');
  const admin = user.role === 'admin';
  const [people, list, site, row] = await Promise.all([
    listPeople(c.env.DB),
    goalsOf(c.env.DB, memberId),
    getSiteSettings(c.env.DB),
    getUserById(c.env.DB, memberId),
  ]);
  const whose = people.find((p) => p.id === memberId);
  if (!whose) return c.notFound();
  const shared = !!c.env.FEDERATION_PRIVATE_KEY && site.namesToConnections && site.goalsToConnections && !!row?.displayName;
  c.status(status);
  return page(
    c,
    'Reading goals',
    <GoalsPage
      whose={whose}
      self={memberId === user.id}
      admin={admin}
      people={people}
      list={list}
      today={todayUtc()}
      shared={shared}
      {...extra}
    />,
  );
}

goals.get('/goals', async (c) => {
  const memberId = whoseGoals(c, c.req.query('member'));
  if (memberId === null) return c.text('You can see and set only your own reading goals.', 403);
  return render(c, memberId);
});

goals.post('/goals', async (c) => {
  const body = await c.req.parseBody();
  const memberId = whoseGoals(c, typeof body['userId'] === 'string' ? body['userId'] : undefined);
  if (memberId === null) return c.text('You can set only your own reading goal: an admin can set anyone’s.', 403);
  const year = Number(body['year']);
  const rawTarget = typeof body['target'] === 'string' ? body['target'] : '';
  const target = parseGoalTarget(rawTarget);
  if (!settableYears(todayUtc()).includes(year)) {
    return render(c, memberId, { error: 'A goal can be set for this year or next.', target: rawTarget }, 400);
  }
  if (target === null) {
    return render(c, memberId, { error: `Give a number of books from 1 to ${MAX_GOAL_TARGET}.`, year, target: rawTarget }, 400);
  }
  const user = c.get('user');
  if (!(await setGoal(c.env.DB, memberId, year, target, { id: user.id, admin: user.role === 'admin' }))) return c.notFound();
  return c.redirect(memberId === user.id ? '/goals' : `/goals?member=${memberId}`);
});

goals.post('/goals/:id/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const goal = Number.isSafeInteger(id) ? await getGoal(c.env.DB, id) : null;
  if (!goal) return c.notFound();
  const user = c.get('user');
  const admin = user.role === 'admin';
  if (goal.userId !== user.id && !admin) return notYours(c);
  await deleteGoal(c.env.DB, id, { id: user.id, admin });
  return c.redirect(goal.userId === user.id ? '/goals' : `/goals?member=${goal.userId}`);
});

export default goals;
