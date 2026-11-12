/**
 * Task 4 corpus: 60 Brindle tickets (20 templates x 3 slot draws) written in English, Spanish,
 * German and Japanese, and the routing and urgency rubric translated into the same three
 * languages. The state around the message (ticket id, channel, plan) stays in English, as an
 * application's own fields would; only the customer's message and, in the translated arm, the
 * question change language. Invariant 9 says English rubrics beat translated ones; the pairing
 * (same ticket, same state, only the question's language differs) is what tests it.
 *
 * Slots hold language-neutral values (numbers, amounts, integration names) so the four
 * renderings carry the same facts. Labels are the English template's route and urgency.
 */
import { Draw, fill } from "./common.ts";
import {
  BRINDLE_CRITERIA,
  BRINDLE_QUEUES,
  BRINDLE_TEMPLATES,
  type BrindleQueue,
  CHANNELS,
  PLANS,
  ROUTE_PROMPT,
  slotsFor,
  type TicketItem,
  ticketState,
  URGENCY_LEVELS,
  URGENCY_PROMPT,
} from "./routing.ts";

export const LANGS = ["es", "de", "ja"] as const;
export type Lang = (typeof LANGS)[number];

/** The 20 templates, in four languages. English is the template's own text. */
export const TRANSLATIONS: Readonly<Record<string, Readonly<Record<Lang, string>>>> = {
  b3: {
    es: "El pago con nuestra tarjeta falló y el aviso dice que el espacio de trabajo se suspenderá mañana. No podemos perder el acceso en la semana de nóminas. ¿Cómo podemos pagar de otra forma?",
    de: "Unsere Kartenzahlung ist fehlgeschlagen, und laut Hinweis wird der Arbeitsbereich morgen gesperrt. Wir dürfen in der Woche der Gehaltsabrechnung den Zugang nicht verlieren. Wie können wir anders bezahlen?",
    ja: "カードでの支払いが失敗し、ワークスペースが明日停止されるという表示が出ています。給与計算の週なのでアクセスを失うわけにはいきません。別の方法で支払うにはどうすればよいですか？",
  },
  b10: {
    es: "Nuestra cuenta pasó a modo de solo lectura porque un pago de {amt} fue rechazado. Nuestro equipo de {n} personas no puede registrar horas hoy. Ayúdennos a pagar ahora mismo, por favor.",
    de: "Unser Konto wurde auf Nur-Lesen umgestellt, weil eine Zahlung über {amt} zurückgebucht wurde. Unser Team aus {n} Personen kann heute keine Zeiten erfassen. Bitte helfen Sie uns, sofort zu bezahlen.",
    ja: "{amt}の支払いが不渡りになったため、アカウントが読み取り専用になりました。{n}人のチームが今日、作業時間を記録できません。今すぐ支払えるよう助けてください。",
  },
  b11: {
    es: "Nos facturaron {n} licencias, pero solo tenemos {n2} usuarios activos. ¿Pueden abonarnos la diferencia?",
    de: "Uns wurden {n} Lizenzen berechnet, wir haben aber nur {n2} aktive Nutzer. Können Sie uns die Differenz gutschreiben?",
    ja: "{n}席分を請求されましたが、実際のアクティブユーザーは{n2}人だけです。差額をクレジットしていただけますか？",
  },
  a1: {
    es: "No puedo iniciar sesión. Dice que mi contraseña es incorrecta y el correo para restablecerla nunca llega. Tengo que enviar facturas a clientes antes de que termine el día.",
    de: "Ich kann mich nicht anmelden. Es heißt, mein Passwort sei falsch, und die E-Mail zum Zurücksetzen kommt nie an. Ich muss bis heute Abend Rechnungen an Kunden schicken.",
    ja: "ログインできません。パスワードが間違っていると表示され、リセット用のメールも届きません。今日中に顧客へ請求書を送らなければなりません。",
  },
  a2: {
    es: "Cambié de teléfono y perdí mi aplicación de verificación en dos pasos. ¿Cómo restablezco el 2FA de mi cuenta? Puedo esperar hasta mañana.",
    de: "Ich habe ein neues Handy und meine Zwei-Faktor-App verloren. Wie setze ich die 2FA für mein Konto zurück? Es kann bis morgen warten.",
    ja: "新しいスマートフォンに替えて、二要素認証アプリが使えなくなりました。アカウントの二要素認証をリセットするにはどうすればよいですか？明日まで待てます。",
  },
  a5: {
    es: "Mi cuenta dice 'desactivada por el administrador', pero yo soy el único administrador. No puedo entrar a nada y hoy se procesan las nóminas.",
    de: "Bei meinem Konto steht 'vom Administrator deaktiviert', aber ich bin der einzige Administrator. Ich komme nirgendwo mehr hinein, und heute läuft die Gehaltsabrechnung.",
    ja: "アカウントに「管理者により無効化されました」と表示されますが、管理者は私だけです。何にもアクセスできず、今日は給与計算の日です。",
  },
  g1: {
    es: "Desde la actualización de ayer, la exportación de hojas de horas a CSV genera un archivo vacío. Las nóminas vencen mañana y necesitamos esas horas.",
    de: "Seit dem gestrigen Update erzeugt der CSV-Export der Stundenzettel eine leere Datei. Die Gehaltsabrechnung ist morgen fällig, und wir brauchen diese Stunden.",
    ja: "昨日のアップデート以降、タイムシートのCSVエクスポートが空のファイルになります。給与計算の締め切りが明日なので、その時間データが必要です。",
  },
  g3: {
    es: "El editor de facturas se bloquea con una pantalla en blanco para todos en nuestra cuenta, {n} usuarios. Ahora mismo nadie puede crear ni enviar facturas.",
    de: "Der Rechnungseditor stürzt bei allen in unserem Konto ab und zeigt nur einen weißen Bildschirm, {n} Nutzer. Im Moment kann niemand Rechnungen erstellen oder versenden.",
    ja: "請求書エディターが、私たちのアカウントの全員（{n}人）で白い画面になってクラッシュします。現在、誰も請求書を作成も送信もできません。",
  },
  g4: {
    es: "Un detalle menor: el selector de fechas muestra el domingo como primer día de la semana aunque elegí el lunes en mis preferencias.",
    de: "Kleinigkeit: Die Datumsauswahl zeigt Sonntag als ersten Wochentag, obwohl ich in meinen Einstellungen Montag gewählt habe.",
    ja: "小さなことですが、設定で月曜日を選んでいるのに、日付選択で日曜日が週の始まりとして表示されます。",
  },
  f1: {
    es: "Sería genial que las facturas pudieran incluir un código QR para el pago.",
    de: "Es wäre toll, wenn Rechnungen einen QR-Code zum Bezahlen enthalten könnten.",
    ja: "請求書に支払い用のQRコードを載せられるようになると、とても助かります。",
  },
  f11: {
    es: "Por favor, aumenten el límite de {n} campos personalizados por cliente. Lo hemos alcanzado y no podemos añadir el campo de impuestos que necesitan nuestros nuevos clientes.",
    de: "Bitte erhöhen Sie das Limit von {n} benutzerdefinierten Feldern pro Kunde. Wir haben es erreicht und können das Steuerfeld, das unsere neuen Kunden brauchen, nicht hinzufügen.",
    ja: "顧客ごとのカスタムフィールドの上限（{n}個）を引き上げてください。上限に達してしまい、新しい顧客に必要な税金のフィールドを追加できません。",
  },
  p2: {
    es: "Por favor, eliminen mi cuenta y todos los datos asociados a ella. Ya no uso el servicio.",
    de: "Bitte löschen Sie mein Konto und alle damit verbundenen Daten. Ich nutze den Dienst nicht mehr.",
    ja: "私のアカウントと、それに関連するすべてのデータを削除してください。もうこのサービスは使っていません。",
  },
  p4: {
    es: "Un exempleado nos ha pedido que borremos sus datos personales y el plazo legal vence este viernes. ¿Cómo eliminamos sus registros de horas y su perfil?",
    de: "Ein ehemaliger Mitarbeiter hat uns aufgefordert, seine personenbezogenen Daten zu löschen, und die gesetzliche Frist endet diesen Freitag. Wie entfernen wir seine Zeiteinträge und sein Profil?",
    ja: "元従業員から個人データの消去を求められており、法定期限は今週の金曜日です。その人の作業時間の記録とプロフィールはどうすれば削除できますか？",
  },
  i2: {
    es: "La sincronización con {int} falla con el error 'token expired' y las facturas no llegan a nuestro sistema contable antes del cierre de mes, que es hoy.",
    de: "Die Synchronisierung mit {int} schlägt mit 'token expired' fehl, und die Rechnungen kommen vor dem Monatsabschluss heute nicht in unserer Buchhaltung an.",
    ja: "{int}との同期が「token expired」で失敗し、今日の月末締めまでに請求書が会計システムに届きません。",
  },
  i8: {
    es: "Su API lleva una hora devolviendo 503 en todas las solicitudes. Nuestro portal de clientes depende de ella y está caído para todos nuestros usuarios.",
    de: "Ihre API gibt seit einer Stunde bei jeder Anfrage 503 zurück. Unser Kundenportal hängt davon ab und ist für alle unsere Nutzer ausgefallen.",
    ja: "過去1時間、御社のAPIがすべてのリクエストに503を返しています。当社の顧客ポータルはこれに依存しており、全ユーザーが利用できない状態です。",
  },
  s1: {
    es: "Acabo de recibir alertas de inicio de sesión desde tres países en la última hora y alguien cambió nuestros datos bancarios de cobro. Por favor, bloqueen nuestra cuenta ya.",
    de: "Ich habe in der letzten Stunde Anmeldewarnungen aus drei Ländern bekommen, und jemand hat unsere Bankverbindung für Auszahlungen geändert. Bitte sperren Sie unser Konto sofort.",
    ja: "この1時間で3か国からのログイン通知が届き、誰かが入金先の銀行口座情報を変更しました。今すぐアカウントをロックしてください。",
  },
  s3: {
    es: "Recibimos un correo que parece suyo y nos pide 'verificar la facturación' en un dominio extraño. ¿Es phishing?",
    de: "Wir haben eine E-Mail bekommen, die von Ihnen zu stammen scheint und uns auffordert, auf einer seltsamen Domain die 'Abrechnung zu bestätigen'. Ist das Phishing?",
    ja: "御社からと思われるメールが届き、見慣れないドメインで「請求情報の確認」をするよう求められました。これはフィッシングですか？",
  },
  s9: {
    es: "Un empleado hizo clic en un enlace de un correo falso de 'factura de Brindle' e introdujo su contraseña. Nos preocupa que la cuenta esté comprometida.",
    de: "Ein Mitarbeiter hat in einer gefälschten 'Brindle-Rechnung'-E-Mail auf einen Link geklickt und sein Passwort eingegeben. Wir befürchten, dass das Konto kompromittiert ist.",
    ja: "従業員の一人が偽の「Brindle請求書」メールのリンクをクリックし、パスワードを入力してしまいました。アカウントが乗っ取られていないか心配です。",
  },
  c2: {
    es: "¿Podrían enviarnos un presupuesto formal para {n} licencias? Nuestro equipo de compras lo necesita para emitir una orden de compra.",
    de: "Könnten Sie uns ein formelles Angebot für {n} Lizenzen schicken? Unser Einkauf braucht es, um eine Bestellung auszulösen.",
    ja: "{n}席分の正式な見積書を送っていただけますか？購買部門が発注書を作成するのに必要です。",
  },
  c3: {
    es: "Queremos pasar al plan Enterprise antes de la reunión del consejo del jueves. ¿Puede llamarme hoy alguien de ventas?",
    de: "Wir möchten vor unserer Vorstandssitzung am Donnerstag auf Enterprise umsteigen. Kann mich heute jemand aus dem Vertrieb anrufen?",
    ja: "木曜日の取締役会までにEnterpriseプランに移行したいと考えています。今日中に営業の方から電話をいただけますか？",
  },
};

const OPENERS: Readonly<Record<"en" | Lang, readonly string[]>> = {
  en: ["", "Hi,", "Hello,"],
  es: ["", "Hola,", "Buenos días,"],
  de: ["", "Hallo,", "Guten Tag,"],
  ja: ["", "こんにちは。", "お世話になっております。"],
};
const CLOSERS: Readonly<Record<"en" | Lang, readonly string[]>> = {
  en: ["", "Thanks.", "Regards."],
  es: ["", "Gracias.", "Saludos."],
  de: ["", "Danke.", "Viele Grüße."],
  ja: ["", "よろしくお願いします。", "ありがとうございます。"],
};

/** The rubric in each language: route prompt, option names and criteria, urgency prompt and levels. */
export interface Rubric {
  readonly routePrompt: string;
  readonly options: Readonly<Record<BrindleQueue, string>>;
  readonly criteria: Readonly<Record<BrindleQueue, string>>;
  readonly urgencyPrompt: string;
  readonly levels: readonly [string, string, string, string];
}

const identity = Object.fromEntries(BRINDLE_QUEUES.map((q) => [q, q])) as Record<
  BrindleQueue,
  string
>;

export const RUBRICS: Readonly<Record<"en" | Lang, Rubric>> = {
  en: {
    routePrompt: ROUTE_PROMPT,
    options: identity,
    criteria: BRINDLE_CRITERIA,
    urgencyPrompt: URGENCY_PROMPT,
    levels: [...URGENCY_LEVELS] as [string, string, string, string],
  },
  es: {
    routePrompt: "¿Qué cola de soporte debe atender este ticket?",
    options: {
      billing: "facturación",
      account_access: "acceso_a_la_cuenta",
      bug: "error",
      feature_request: "solicitud_de_función",
      data_privacy: "privacidad_de_datos",
      integrations: "integraciones",
      security: "seguridad",
      sales: "ventas",
    },
    criteria: {
      billing:
        "Cargos, facturas, recibos, reembolsos de cuotas de suscripción, pagos fallidos, cambio de la tarjeta registrada o de la dirección de facturación.",
      account_access:
        "No se puede iniciar sesión, restablecimiento de contraseñas, códigos de verificación en dos pasos, errores de inicio de sesión único (SSO), cuentas bloqueadas o desactivadas, cambio del correo de la cuenta.",
      bug: "Una función del producto no funciona, muestra un error o da resultados incorrectos.",
      feature_request:
        "Pide una capacidad que el producto no tiene o un cambio en su funcionamiento.",
      data_privacy:
        "Solicitudes para exportar, corregir o eliminar datos personales; preguntas sobre el RGPD o la CCPA; acuerdos de tratamiento de datos; conservación de datos.",
      integrations:
        "Conexión o resolución de problemas con aplicaciones de terceros y la API: Slack, QuickBooks, Xero, Zapier, webhooks, claves de API, límites de uso.",
      security:
        "Sospecha de cuenta comprometida, inicios de sesión no reconocidos, phishing que se hace pasar por nosotros, credenciales expuestas, informes de vulnerabilidades.",
      sales:
        "Compra, mejora de plan o licencias adicionales, presupuestos, precios empresariales, pruebas, demostraciones, documentación de compras.",
    },
    urgencyPrompt:
      "¿Qué tan urgente es este ticket? baja: una pregunta, idea o comentario sin presión de tiempo. normal: una solicitud o un problema que no impide trabajar a nadie, o que tiene una solución provisional. alta: bloquea hoy el trabajo de una persona o un equipo sin solución provisional, o pone en riesgo un pago o un plazo legal en los próximos días. crítica: una caída o pérdida de datos que afecta a muchos usuarios, o una brecha de seguridad en curso.",
    levels: ["baja", "normal", "alta", "crítica"],
  },
  de: {
    routePrompt: "Welche Support-Warteschlange soll dieses Ticket bearbeiten?",
    options: {
      billing: "abrechnung",
      account_access: "kontozugang",
      bug: "fehler",
      feature_request: "funktionswunsch",
      data_privacy: "datenschutz",
      integrations: "integrationen",
      security: "sicherheit",
      sales: "vertrieb",
    },
    criteria: {
      billing:
        "Abbuchungen, Rechnungen, Belege, Erstattungen von Abogebühren, fehlgeschlagene Zahlungen, Ändern der hinterlegten Karte oder der Rechnungsadresse.",
      account_access:
        "Anmeldung nicht möglich, Passwort zurücksetzen, Zwei-Faktor-Codes, Fehler bei der Einmalanmeldung (SSO), gesperrte oder deaktivierte Konten, Ändern der Konto-E-Mail.",
      bug: "Eine Funktion des Produkts ist defekt, zeigt einen Fehler an oder liefert falsche Ergebnisse.",
      feature_request:
        "Wünscht eine Funktion, die das Produkt nicht hat, oder eine Änderung an seiner Funktionsweise.",
      data_privacy:
        "Anfragen zum Exportieren, Berichtigen oder Löschen personenbezogener Daten; Fragen zur DSGVO oder zum CCPA; Auftragsverarbeitungsverträge; Datenaufbewahrung.",
      integrations:
        "Verbinden von Drittanbieter-Apps und der API oder Fehlersuche dabei: Slack, QuickBooks, Xero, Zapier, Webhooks, API-Schlüssel, Ratenlimits.",
      security:
        "Verdacht auf ein kompromittiertes Konto, unbekannte Anmeldungen, Phishing in unserem Namen, offengelegte Zugangsdaten, Meldungen von Sicherheitslücken.",
      sales:
        "Kauf, Upgrade oder zusätzliche Lizenzen, Angebote, Enterprise-Preise, Testphasen, Demos, Beschaffungsunterlagen.",
    },
    urgencyPrompt:
      "Wie dringend ist dieses Ticket? niedrig: eine Frage, Idee oder Rückmeldung ohne Zeitdruck. normal: eine Anfrage oder ein Problem, das niemanden an der Arbeit hindert oder für das es einen Workaround gibt. hoch: blockiert heute die Arbeit einer Person oder eines Teams ohne Workaround oder gefährdet eine Zahlung oder gesetzliche Frist in den nächsten Tagen. kritisch: ein Ausfall oder Datenverlust, der viele Nutzer betrifft, oder ein laufender Sicherheitsvorfall.",
    levels: ["niedrig", "normal", "hoch", "kritisch"],
  },
  ja: {
    routePrompt: "このチケットはどのサポートキューが対応すべきですか？",
    options: {
      billing: "請求",
      account_access: "アカウントアクセス",
      bug: "不具合",
      feature_request: "機能要望",
      data_privacy: "データプライバシー",
      integrations: "連携",
      security: "セキュリティ",
      sales: "営業",
    },
    criteria: {
      billing:
        "請求額、請求書、領収書、サブスクリプション料金の返金、支払いの失敗、登録カードや請求先住所の変更。",
      account_access:
        "ログインできない、パスワードのリセット、二要素認証コード、シングルサインオンのエラー、ロックまたは無効化されたアカウント、アカウントのメールアドレス変更。",
      bug: "製品の機能が壊れている、エラーが表示される、または誤った結果を返す。",
      feature_request: "製品にない機能の追加や、動作の変更を求めている。",
      data_privacy:
        "個人データのエクスポート・訂正・削除の依頼、GDPRやCCPAに関する質問、データ処理契約、データの保存期間。",
      integrations:
        "サードパーティアプリやAPIとの連携やトラブルシューティング：Slack、QuickBooks、Xero、Zapier、Webhook、APIキー、レート制限。",
      security:
        "アカウント乗っ取りの疑い、身に覚えのないログイン、当社を装ったフィッシング、認証情報の流出、脆弱性の報告。",
      sales:
        "購入、プランのアップグレードや席の追加、見積もり、エンタープライズ価格、トライアル、デモ、購買手続きの書類。",
    },
    urgencyPrompt:
      "このチケットの緊急度はどれくらいですか？ 低：時間的な制約のない質問、アイデア、フィードバック。 通常：誰の作業も止めていない依頼や問題、または回避策がある問題。 高：回避策がなく、今日、個人やチームの作業を止めている、または数日以内に支払いや法的期限に間に合わないおそれがある。 緊急：多くのユーザーに影響する障害やデータ消失、または進行中のセキュリティ侵害。",
    levels: ["低", "通常", "高", "緊急"],
  },
};

export interface MultilingualItem {
  readonly id: string;
  readonly template: string;
  /** The ticket's state in each language: same id, channel and plan, the message translated. */
  readonly states: Readonly<Record<"en" | Lang, string>>;
  readonly route: TicketItem<BrindleQueue>["route"];
  readonly urgency: TicketItem<BrindleQueue>["urgency"];
}

export function buildMultilingual(seed = 59): MultilingualItem[] {
  const d = new Draw(seed);
  const out: MultilingualItem[] = [];
  const ids = new Set<string>();
  for (const key of Object.keys(TRANSLATIONS)) {
    const t = BRINDLE_TEMPLATES.find((x) => x.id === key);
    const tr = TRANSLATIONS[key];
    if (!t || !tr) throw new Error(`no template ${key}`);
    for (let k = 0; k < 3; k++) {
      const slots = slotsFor(d);
      const o = d.int(0, 2);
      const c = d.int(0, 2);
      let id = `T-${d.int(10000, 99999)}`;
      while (ids.has(id)) id = `T-${d.int(10000, 99999)}`;
      ids.add(id);
      const channel = d.pick(CHANNELS);
      const plan = d.pick(PLANS);
      const body = (lang: "en" | Lang): string => {
        const text = lang === "en" ? t.t : tr[lang];
        const sep = lang === "ja" ? "" : " ";
        return [OPENERS[lang][o], fill(text, slots), CLOSERS[lang][c]]
          .filter((s) => s !== undefined && s !== "")
          .join(sep);
      };
      // The same channel and plan in every language: only the message changes.
      const stateFor = (lang: "en" | Lang) => ticketState("brindle", id, channel, plan, body(lang));
      out.push({
        id,
        template: t.id,
        states: { en: stateFor("en"), es: stateFor("es"), de: stateFor("de"), ja: stateFor("ja") },
        route: { ...(t.ambRoute ? { ambiguous: true } : {}), truth: t.q, why: `${t.q}: ${t.r}` },
        urgency: {
          ...(t.ambUrgency ? { ambiguous: true } : {}),
          truth: t.u,
          why: `${t.u}: ${t.r}`,
        },
      });
    }
  }
  return d.shuffle(out);
}
