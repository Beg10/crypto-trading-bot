import { Context } from 'grammy';
import { getUserByTelegramId, setCapital } from '../db';

export async function handleCapital(ctx: Context): Promise<void> {
  const user = await getUserByTelegramId(ctx.from!.id);
  if (!user) {
    await ctx.reply('Bitte zuerst /start verwenden.');
    return;
  }

  const args = ctx.message?.text?.split(' ').slice(1) ?? [];

  if (args.length === 0) {
    // Show current capital
    if (user.capital == null) {
      await ctx.reply(
        '💼 *Kapital nicht gesetzt.*\n\n' +
          'Benutze `/capital 5000` um dein verfügbares Handelskapital zu setzen.\n\n' +
          'Dann berechne ich automatisch die Positionsgröße in Signal\\-Alerts _(2% Risiko\\-Modell)_.',
        { parse_mode: 'Markdown' },
      );
    } else {
      await ctx.reply(
        `💼 *Dein Handelskapital:* $${user.capital.toLocaleString('en-US', { maximumFractionDigits: 2 })}\n\n` +
          'Ändern: `/capital 10000`\n' +
          'Entfernen: `/capital reset`',
        { parse_mode: 'Markdown' },
      );
    }
    return;
  }

  const arg = args[0].toLowerCase();

  if (arg === 'reset') {
    await setCapital(user.id, null);
    await ctx.reply('✅ Kapital zurückgesetzt. Signal-Alerts kommen ohne Positionsgrößen-Empfehlung.');
    return;
  }

  const amount = parseFloat(arg.replace(',', '.'));
  if (isNaN(amount) || amount <= 0) {
    await ctx.reply('❌ Ungültiger Betrag. Beispiel: `/capital 5000`', { parse_mode: 'Markdown' });
    return;
  }

  await setCapital(user.id, amount);
  const maxLoss = (amount * 0.02).toFixed(2);
  await ctx.reply(
    `✅ *Kapital gesetzt:* $${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}\n\n` +
      `Bei jedem Signal berechne ich die Positionsgröße basierend auf *2% Risiko pro Trade* (max. $${maxLoss} Verlust).\n\n` +
      'Entfernen: `/capital reset`',
    { parse_mode: 'Markdown' },
  );
}
