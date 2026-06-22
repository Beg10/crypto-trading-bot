import { Context } from 'grammy';
import { supabase } from '../db';

export async function handleIn(ctx: Context): Promise<void> {
  const text  = ctx.message?.text ?? '';
  const parts = text.trim().split(/\s+/);
  if (parts.length < 4) {
    await ctx.reply(
      'Format: `/in SYMBOL MARGIN HEBEL` — z.B. `/in SOLUSDT 100 20`',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const symbol   = parts[1].toUpperCase();
  const margin   = parseFloat(parts[2]);
  const leverage = parseInt(parts[3], 10);

  if (isNaN(margin) || margin <= 0 || isNaN(leverage) || leverage <= 0) {
    await ctx.reply('Ungueltige Werte. Margin und Hebel muessen positive Zahlen sein.');
    return;
  }

  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  try {
    await supabase
      .from('user_positions')
      .update({ is_active: false })
      .eq('telegram_id', telegramId)
      .eq('symbol', symbol)
      .eq('is_active', true);

    await supabase.from('user_positions').insert({
      telegram_id: telegramId,
      symbol,
      margin,
      leverage,
    });

    const position = margin * leverage;
    await ctx.reply(
      `*Position registriert!*\n\n` +
      `*${symbol}* — ${margin}$ Margin x ${leverage}x Hebel\n` +
      `*Positionsgroesse:* ${position.toFixed(0)}$\n\n` +
      `Du bekommst bei TP/SL eine persoenliche P&L-Berechnung!\n\n` +
      `_/out ${symbol} zum Schliessen_`,
      { parse_mode: 'Markdown' },
    );
  } catch (e) {
    console.error('[position] handleIn error:', e);
    await ctx.reply('Fehler beim Speichern. Versuche es nochmal.');
  }
}

export async function handleOut(ctx: Context): Promise<void> {
  const text  = ctx.message?.text ?? '';
  const parts = text.trim().split(/\s+/);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  if (parts.length < 2) {
    await ctx.reply('Format: `/out SYMBOL` z.B. `/out SOLUSDT`', { parse_mode: 'Markdown' });
    return;
  }

  const symbol = parts[1].toUpperCase();
  try {
    const { data } = await supabase
      .from('user_positions')
      .update({ is_active: false })
      .eq('telegram_id', telegramId)
      .eq('symbol', symbol)
      .eq('is_active', true)
      .select('id');

    if ((data?.length ?? 0) > 0) {
      await ctx.reply(`Position *${symbol}* geschlossen.`, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(`Keine aktive Position in *${symbol}* gefunden.`, { parse_mode: 'Markdown' });
    }
  } catch (e) {
    await ctx.reply('Fehler. Versuche es nochmal.');
  }
}

export async function handlePos(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  try {
    const { data } = await supabase
      .from('user_positions')
      .select('symbol, margin, leverage, opened_at')
      .eq('telegram_id', telegramId)
      .eq('is_active', true)
      .order('opened_at', { ascending: false });

    if (!data || data.length === 0) {
      await ctx.reply(
        'Keine aktiven Positionen.\n\nBenutze `/in SYMBOL MARGIN HEBEL` um eine Position zu tracken.',
        { parse_mode: 'Markdown' },
      );
      return;
    }

    const lines = (data as Array<{ symbol: string; margin: number; leverage: number; opened_at: string }>).map((p) => {
      const pos = p.margin * p.leverage;
      const age = Math.round((Date.now() - new Date(p.opened_at).getTime()) / 1000 / 60 / 60);
      return `- *${p.symbol}* — ${p.margin}$ x ${p.leverage}x = ${pos}$ _(vor ${age}h)_`;
    });

    await ctx.reply(
      `*Aktive Positionen:*\n\n${lines.join('\n')}\n\n_/out SYMBOL zum Schliessen_`,
      { parse_mode: 'Markdown' },
    );
  } catch (e) {
    await ctx.reply('Fehler beim Laden.');
  }
}
