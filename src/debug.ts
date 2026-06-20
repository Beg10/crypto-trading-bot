import 'dotenv/config';
import { validateSymbol } from './services/binance';
import { supabase, getUserByTelegramId, addToWatchlist } from './db';

async function main() {
  console.log('--- ENV CHECK ---');
  console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? 'set' : 'MISSING');
  console.log('SUPABASE_KEY:', process.env.SUPABASE_KEY?.slice(0, 12) + '...');

  console.log('\n--- BINANCE validateSymbol BTCUSDT ---');
  try {
    const ok = await validateSymbol('BTCUSDT');
    console.log('result:', ok);
  } catch (e) {
    console.error('FAIL:', (e as Error).message);
  }

  console.log('\n--- SUPABASE users select ---');
  try {
    const { data, error } = await supabase.from('users').select('id, telegram_id, username').limit(5);
    console.log('rows:', data, 'error:', error);
  } catch (e) {
    console.error('FAIL:', (e as Error).message);
  }

  console.log('\n--- SUPABASE watchlist insert dummy ---');
  try {
    const { data: users } = await supabase.from('users').select('id').limit(1);
    if (!users?.[0]) {
      console.log('no user in db — /start may have failed');
      return;
    }
    await addToWatchlist(users[0].id, 'TESTUSDT');
    console.log('insert OK');
    await supabase.from('watchlist').delete().eq('user_id', users[0].id).eq('symbol', 'TESTUSDT');
  } catch (e) {
    console.error('FAIL:', (e as Error).message);
  }
}

main().then(() => process.exit(0));
