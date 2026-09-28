// クラウド（GitHub Actions）でThreadsへ予約投稿する。
// - queue.json はMacのダッシュボードだけが書く（承認済み・予約時刻つきの投稿）
// - results.json はこのプログラムだけが書く（投稿中／投稿済み／失敗／要確認）
// - 投稿の直前に「投稿中」を記録してpushしてから送る（途中で止まっても二重投稿しない）
// - トークンは GitHub Secrets（THREADS_TOKEN_KIMURA / THREADS_TOKEN_OFFICIAL）。画面やログに出さない
// - 公開リポジトリなので queue.json は暗号化（AES-256-GCM・鍵は Secrets の QUEUE_KEY）。ログにも本文を出さない
// 使い方: node poster.mjs         … 予約時刻を過ぎた投稿を1回出す
//         node poster.mjs --loop  … 次の予約時刻まで待って出すのを繰り返す（最長 LOOP_MINUTES 分。予約が残っていれば次の実行を起動して引き継ぐ）
//         node poster.mjs --check … 投稿せず、各名義のトークンで本人IDが一致するかだけ確認する
//         DRY_RUN=1 をつけると、投稿も結果の記録もせずに流れだけ確かめる
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';

const API = 'https://graph.threads.net';
const VERSION = 'v1.0';
const TEXT_LIMIT = 500;
const LATE_LIMIT_MS = 6 * 60 * 60 * 1000;
const TOKENS = { kimura: process.env.THREADS_TOKEN_KIMURA, official: process.env.THREADS_TOKEN_OFFICIAL };
const CHECK_ONLY = process.argv.includes('--check');
const LOOP = process.argv.includes('--loop');
const DRY = process.env.DRY_RUN === '1';
const LOOP_MS = Number(process.env.LOOP_MINUTES || 340) * 60 * 1000;
const POLL_MS = 60 * 1000;
const dryDone = new Set(); // DRY_RUN で「出したことにした」投稿

const readJSON = (f) => JSON.parse(readFileSync(f, 'utf8'));
function readQueue() {
  if (!existsSync('queue.json')) return { accounts: {}, items: [] };
  const q = readJSON('queue.json');
  if (!q.enc) return q;
  const key = Buffer.from(process.env.QUEUE_KEY || '', 'base64');
  const buf = Buffer.from(q.enc, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}
const writeJSON = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();

function countText(text) {
  let n = 0;
  for (const ch of text || '') n += /\p{Extended_Pictographic}|[‍️\u{1f3fb}-\u{1f3ff}]/u.test(ch) ? Buffer.byteLength(ch, 'utf8') : 1;
  return n;
}

class ThreadsError extends Error {}

async function call(method, path, params, token) {
  const url = new URL(`${API}/${VERSION}${path}`);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, access_token: token })) {
    if (v === undefined || v === null || v === '') continue;
    if (method === 'GET') url.searchParams.set(k, v); else body.set(k, v);
  }
  let res;
  try { res = await fetch(url, method === 'GET' ? { method } : { method, body }); }
  catch (e) { throw new ThreadsError('Threadsに接続できませんでした'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new ThreadsError(`Threadsからエラー: ${json.error?.message || `HTTP ${res.status}`}`);
  return json;
}

// results.json だけをコミットしてpushする（ダッシュボードが queue.json を同時に更新しても衝突しないよう、失敗したら取り込み直す）
function pushResults(message) {
  if (DRY) return;
  for (let i = 0; i < 5; i++) {
    try {
      execSync('git add results.json', { stdio: 'ignore' });
      execSync(`git diff --cached --quiet || git commit -q -m ${JSON.stringify(message)}`, { stdio: 'ignore', shell: '/bin/bash' });
      execSync('git pull -q --rebase', { stdio: 'ignore' });
      execSync('git push -q', { stdio: 'ignore' });
      return;
    } catch (_) { execSync('sleep 3'); }
  }
  throw new Error('results.json をpushできませんでした');
}

// 公式の推奨：作成から公開まで30秒ほど待つ。動画は処理に時間がかかるので、最大5分ほど確認する
async function waitReady(id, token) {
  for (const ms of [30000, 60000, 60000, 60000, 60000]) {
    await sleep(ms);
    const st = await call('GET', `/${id}`, { fields: 'status,error_message' }, token);
    if (st.status === 'FINISHED' || st.status === 'PUBLISHED') return;
    if (st.status === 'ERROR' || st.status === 'EXPIRED') throw new ThreadsError(`投稿の準備でエラー: ${st.error_message || st.status}`);
  }
  throw new ThreadsError('投稿の準備が時間内に終わりませんでした');
}

// 添付の公開URLが見られる状態か（GitHub Pagesへの反映待ちなら今回は見送る）
async function mediaReady(item) {
  for (const m of item.media || []) {
    const r = await fetch(m.url, { method: 'HEAD' }).catch(() => null);
    if (!r || !r.ok) return false;
  }
  return true;
}

async function publish(item, userId, token) {
  const media = (item.media || []).filter((m) => m && m.url);
  if (!item.text?.trim() && !media.length) throw new ThreadsError('本文が空です');
  if (countText(item.text) > TEXT_LIMIT) throw new ThreadsError('本文が500文字を超えています');
  if (media.length > 20) throw new ThreadsError('まとめて投稿できるのは20点までです');
  const who = await call('GET', '/me', { fields: 'id,username' }, token);
  if (String(who.id) !== String(userId)) throw new ThreadsError('Threadsの接続先が予約の投稿先と一致しません。投稿を止めました');
  const one = (m, extra = {}) => m.type === 'video' ? { media_type: 'VIDEO', video_url: m.url, ...extra } : { media_type: 'IMAGE', image_url: m.url, ...extra };
  let container;
  if (!media.length) container = await call('POST', `/${userId}/threads`, { media_type: 'TEXT', text: item.text, topic_tag: item.topic_tag }, token);
  else if (media.length === 1) container = await call('POST', `/${userId}/threads`, { ...one(media[0]), text: item.text, topic_tag: item.topic_tag }, token);
  else {
    const children = [];
    for (const m of media) {
      const c = await call('POST', `/${userId}/threads`, one(m, { is_carousel_item: 'true' }), token);
      await waitReady(c.id, token);
      children.push(c.id);
    }
    container = await call('POST', `/${userId}/threads`, { media_type: 'CAROUSEL', children: children.join(','), text: item.text, topic_tag: item.topic_tag }, token);
  }
  await waitReady(container.id, token);
  const published = await call('POST', `/${userId}/threads_publish`, { creation_id: container.id }, token);
  let permalink = null;
  try { permalink = (await call('GET', `/${published.id}`, { fields: 'permalink' }, token)).permalink || null; } catch (_) {}
  // 自分の投稿へのコメント（noteのURLなど）。失敗しても本体の投稿は成功扱いにし、理由を残す
  let reply_error = null; let reply_id = null;
  if (item.self_reply && String(item.self_reply).trim()) {
    try {
      const rc = await call('POST', `/${userId}/threads`, { media_type: 'TEXT', text: item.self_reply, reply_to_id: published.id }, token);
      await waitReady(rc.id, token);
      reply_id = (await call('POST', `/${userId}/threads_publish`, { creation_id: rc.id }, token)).id;
    } catch (e) { reply_error = `自分へのコメントを付けられませんでした：${e.message}`; }
  }
  return { id: published.id, permalink, reply_id, reply_error };
}

async function main() {
  if (!LOOP) return runOnce();
  const start = Date.now();
  for (;;) {
    try { execSync('git pull -q --rebase', { stdio: 'ignore' }); } catch (_) {}
    await runOnce();
    const results = readJSON('results.json');
    const next = (readQueue().items || []).filter((it) => !results[it.id] && !dryDone.has(it.id) && it.scheduled_at)
      .map((it) => new Date(it.scheduled_at).getTime()).sort((a, b) => a - b)[0];
    if (!next) { console.log('残りの予約はありません。終了します'); return; }
    const left = start + LOOP_MS - Date.now();
    if (next - Date.now() > left) {
      // 次の予約までにこの実行の上限が来る → 次の実行を起動して引き継ぐ（同時に動くのは1つだけ）
      if (left > POLL_MS) { await sleep(Math.min(left - POLL_MS, POLL_MS)); continue; }
      if (process.env.CHAIN === 'false') { console.log('引き継ぎなしの指定なので終了します'); return; }
      execSync(`gh workflow run post.yml --repo "$GITHUB_REPOSITORY"${DRY ? ` -f dry=true -f chain=false -f minutes=${Number(process.env.LOOP_MINUTES || 340)}` : ''}`, { stdio: 'inherit' });
      console.log('次の実行を起動して引き継ぎました');
      return;
    }
    const wait = next - Date.now();
    await sleep(wait > 0 ? Math.min(POLL_MS, wait) : 30000); // 時刻を過ぎても出せなかった分（添付の反映待ちなど）は30秒おきに再確認
  }
}

async function runOnce() {
  const queue = readQueue();
  if (CHECK_ONLY) {
    for (const [acc, info] of Object.entries(queue.accounts || {})) {
      if (!TOKENS[acc]) { console.log(`${acc}: トークン未設定`); continue; }
      const who = await call('GET', '/me', { fields: 'id,username' }, TOKENS[acc]).catch((e) => ({ error: e.message }));
      console.log(`${acc}: ${who.error ? who.error : (String(who.id) === String(info.user_id) ? `OK @${who.username}` : '本人IDが一致しません')}`);
    }
    return;
  }
  const results = readJSON('results.json');
  const now = Date.now();
  // 読み込み後に時間がたっても予約判定がずれないよう、毎回ここで現在時刻を取る
  const due = (queue.items || [])
    .filter((it) => !results[it.id] && !dryDone.has(it.id) && it.scheduled_at && new Date(it.scheduled_at).getTime() <= now)
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  if (!due.length) return;

  for (const it of due) {
    const userId = queue.accounts?.[it.account_id]?.user_id;
    const token = TOKENS[it.account_id];
    if (now - new Date(it.scheduled_at).getTime() > LATE_LIMIT_MS) {
      results[it.id] = { status: 'needs_check', at: nowISO(), error: '予約時刻から6時間以上たっていたため、投稿を止めました。時刻を決め直すか、今すぐ投稿してください。' };
      writeJSON('results.json', results); pushResults(`late ${it.id}`); continue;
    }
    if (!userId || !token) {
      results[it.id] = { status: 'failed', at: nowISO(), error: 'クラウド側にこの投稿先の接続情報がありません。' };
      writeJSON('results.json', results); pushResults(`failed ${it.id}`); continue;
    }
    if (!(await mediaReady(it))) { console.log(`${it.id}: 添付の公開URLがまだ見られないので次回に回します`); continue; }
    if (DRY) { console.log(`[DRY] ${it.id} を ${it.account_id} へ投稿するところです（予約 ${it.scheduled_at}）`); dryDone.add(it.id); continue; }
    results[it.id] = { status: 'posting', at: nowISO() };
    writeJSON('results.json', results); pushResults(`posting ${it.id}`);
    try {
      const r = await publish(it, userId, token);
      results[it.id] = { status: 'posted', at: nowISO(), posted_at: nowISO(), threads_id: r.id, permalink: r.permalink, reply_id: r.reply_id || null, reply_error: r.reply_error || null };
      console.log(`${it.account_id}へ投稿しました: ${it.id}`);
    } catch (e) {
      const maybeSent = !(e instanceof ThreadsError) || /接続できませんでした/.test(e.message);
      results[it.id] = maybeSent
        ? { status: 'needs_check', at: nowISO(), error: `${e.message}（Threadsアプリで投稿されていないか確認してから、再投稿してください）` }
        : { status: 'failed', at: nowISO(), error: e.message };
      console.log(`投稿に失敗: ${e.message}`);
    }
    writeJSON('results.json', results); pushResults(`${results[it.id].status} ${it.id}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
