// Utilidades compartidas por los motores.

// WhatsApp (o el navegador) no contesta: distinto de "ese número no tiene WhatsApp".
// El servidor no marca la cita como omitida: se reintentará.
const sinRespuesta = () => Object.assign(new Error('WhatsApp no responde'), { sinRespuesta: true });

// La promesa de entrada, o sinRespuesta() si tarda más de ms. Sin temporizadores colgados.
function conLimite(promesa, ms) {
  let t;
  const limite = new Promise((_, rechazar) => { t = setTimeout(() => rechazar(sinRespuesta()), ms); });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(t));
}

module.exports = { sinRespuesta, conLimite };
