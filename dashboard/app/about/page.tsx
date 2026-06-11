import Link from "next/link";

export const revalidate = 3600;

export const metadata = {
  title: "que es esto - Timberbot",
};

export default function About() {
  return (
    <main className="wrap prose">
      <header className="top">
        <Link href="/" className="brand">
          <span className="dot" />
          timberbot
        </Link>
        <nav className="nav">
          <Link href="/" className="navlink">
            ← volver
          </Link>
        </nav>
      </header>

      <h1>Qué es esto</h1>
      <p className="lead">
        Agarré un poco de plata real, la metí en una cuenta de inversión y dejé que un bot de inteligencia artificial la
        maneje solo. La idea es simple y medio absurda: ver si una IA puede ganarle al mercado eligiendo acciones a mano.
        Todo lo que hace queda a la vista, gane o pierda.
      </p>

      <h2>Cómo funciona</h2>
      <p>El sistema tiene dos cerebros separados, a propósito:</p>
      <ul>
        <li>
          <strong>El que piensa</strong> (un modelo grande de IA, una o dos veces por día) lee noticias y mira el
          mercado, y escribe un plan: qué comprar, a qué precio, con qué stop loss y qué objetivo.
        </li>
        <li>
          <strong>El que ejecuta</strong> (código puro, sin IA, prendido todo el día) mira los precios cada minuto y
          cumple ese plan al pie de la letra. Nunca improvisa ni se le ocurre nada raro.
        </li>
      </ul>
      <p>La IA piensa, el código obedece. Esa separación es lo que lo hace barato, predecible y difícil de romper.</p>

      <h2>Contra quién compite</h2>
      <p>En el gráfico de la portada el bot corre contra tres rivales, todos arrancando con la misma plata el mismo día:</p>
      <ul>
        <li>
          <strong>El S&amp;P 500.</strong> La jugada aburrida y honesta: metés la plata en el índice de las 500 empresas
          más grandes de Estados Unidos y no tocás nada. Es el rival serio, al que de verdad hay que ganarle.
        </li>
        <li>
          <strong>La Cartera Adorni.</strong> Acá no hay medias tintas: todo al Bitcoin. El nombre es un homenaje al
          genio que, según cuenta la leyenda, metió todo al Bitcoin allá por 2013. Un crack adelantado a su época.
        </li>
        <li>
          <strong>El Bot Costiorto.</strong> Por lejos la decisión más prudente de todas: te duplica la plata mes a mes,
          sin falla, para siempre. ¿Qué puede salir mal?
        </li>
      </ul>

      <h2>Las reglas de la casa</h2>
      <p>El bot no puede hacer cualquier cosa. Hay límites escritos en el código que ni la IA puede saltarse:</p>
      <ul>
        <li>Nunca invierte más que el capital inicial.</li>
        <li>Máximo 40% en una sola acción, máximo 8 órdenes por día.</li>
        <li>Toda compra lleva su stop loss obligatorio.</li>
        <li>Si pierde 8% en un día, deja de comprar hasta el día siguiente.</li>
        <li>Si la plata cae por debajo del 65% del arranque, se congela todo hasta que lo revise a mano.</li>
      </ul>

      <h2>Las cuentas claras</h2>
      <p>
        También muestro cuánto cuesta hacerlo pensar (las llamadas a la IA), restado de lo que gana. Esa es la gracia:
        ver si después de pagar el cerebro, queda algo. La fuente de verdad es una base de datos en una compu prendida
        24/7; esta página es solo un espejo de lectura.
      </p>

      <p className="disclaimer">
        Nada de esto es consejo financiero ni una invitación a invertir. Es un experimento con plata que se puede perder.
        No me copies, miralo de afuera y reíte conmigo.
      </p>

      <footer>
        <Link href="/">← volver al tablero</Link>
      </footer>
    </main>
  );
}
