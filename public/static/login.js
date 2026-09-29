const messages = {
  invalid: 'Onjuiste gebruikersnaam of wachtwoord.',
  blocked: 'Te veel mislukte pogingen. Probeer het over 15 minuten opnieuw.',
};
const code = new URLSearchParams(location.search).get('error');
if (messages[code]) {
  const el = document.getElementById('error');
  el.textContent = messages[code];
  el.style.display = 'block';
}
