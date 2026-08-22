# cli-ck-shell-integration (zshrc)
#
# Emits OSC 7 (cwd) + OSC 133 A/B/C/D (prompt-start / prompt-end / pre-exec /
# command-done-with-exit-code) so the host can detect command boundaries and
# track cwd without re-parsing the prompt. `status` is a read-only special in
# zsh, so we shadow $? into `_oz_ret`.

# Unset npm_config_prefix to prevent NVM compatibility errors
unset npm_config_prefix

# Prepend standard macOS binary paths to PATH to prevent NVM/node startup warnings
for _oz_bin_path in "/opt/homebrew/bin" "/opt/homebrew/sbin" "/usr/local/bin" "$HOME/.local/bin"; do
  if [[ ":$PATH:" != *":$_oz_bin_path:"* ]]; then
    if [ -d "$_oz_bin_path" ]; then
      export PATH="$_oz_bin_path:$PATH"
    fi
  fi
done
unset _oz_bin_path

{
  _oz_user_zdotdir="${OZ_USER_ZDOTDIR:-$HOME}"
  [ -f "$_oz_user_zdotdir/.zshrc" ] && source "$_oz_user_zdotdir/.zshrc"
  unset _oz_user_zdotdir
}

# Re-source guard within a single shell (e.g. user runs `source ~/.zshrc`).
# This is NOT exported, so each nested zsh installs its own hooks — desired,
# since every interactive shell needs its own prompt integration.
if [[ -z "$__OZ_HOOKS_LOADED" ]]; then
  __OZ_HOOKS_LOADED=1
  autoload -Uz add-zsh-hook 2>/dev/null

  # URL-encode $PWD byte-wise so multi-byte paths stay valid in the `file://`
  # URI emitted via OSC 7. `no_multibyte` forces ${s[i]} to index bytes (not
  # code points), and LC_ALL=C keeps the [a-zA-Z0-9...] class single-byte.
  _oz_urlencode() {
    emulate -L zsh
    setopt localoptions no_multibyte
    local LC_ALL=C s="$1" i byte
    for (( i=1; i<=${#s}; i++ )); do
      byte="${s[i]}"
      case "$byte" in
        [a-zA-Z0-9/._~-]) printf '%s' "$byte" ;;
        *) printf '%%%02X' "'$byte" ;;
      esac
    done
  }

  _oz_precmd() {
    local _oz_ret=$?
    printf '\e]133;D;%s\e\\' "$_oz_ret"
    printf '\e]7;file://%s%s\e\\' "${HOST}" "$(_oz_urlencode "$PWD")"
    # In block mode the host renders its own input bar, so suppress the shell
    # prompt entirely (keep only the OSC 133 B marker) and add a leading blank
    # line so frozen command blocks get vertical breathing room.
    if [[ -n "$OZ_BLOCKS" ]]; then
      # Spacing reserved for the host-drawn block header lives in the prompt
      # (the grid is WebGL, not CSS). Later prompts get two blank rows: the
      # upper one is the previous block's end gap (above its divider), the lower
      # one is this command's header row. The very first prompt has no block
      # above it, so it gets a single row (header only) to avoid a tall top gap.
      if [[ -n "$_oz_block_seen" ]]; then
        PS1=$'\n\n%{\e]133;B\e\\%}'
      else
        PS1=$'\n%{\e]133;B\e\\%}'
      fi
      RPROMPT=''
    elif [[ "$PS1" != *$'\e]133;B\e\\'* ]]; then
      # Re-inject prompt-end marker in case a framework rebuilt PS1 (p10k, starship).
      PS1=$'%{\e]133;B\e\\%}'"$PS1"
    fi
    printf '\e]133;A\e\\'
  }

  _oz_preexec() {
    # Mark that a real command ran, so the next prompt switches from one blank
    # row (first prompt, no block above) to two (end gap + header row).
    [[ -n "$OZ_BLOCKS" ]] && _oz_block_seen=1
    local cmd="${1//[[:cntrl:]]/ }"
    printf '\e]133;C;%s\e\\' "${cmd[1,256]}"
  }

  if (( $+functions[add-zsh-hook] )); then
    add-zsh-hook precmd _oz_precmd
    add-zsh-hook preexec _oz_preexec
  fi

  # Warp/iTerm2-style word-end navigation: zsh's default `forward-word` (M-f /
  # Option+Right) overshoots to the START of the next word; `emacs-forward-word`
  # stops at the END of the current word, which is what nearly every other shell
  # and GUI editor does. Only rebind when the binding is still the stock zsh
  # default — respects any explicit remap in the user's .zshrc.
  if (( $+widgets[emacs-forward-word] )) \
     && [[ "$(bindkey '\ef')" == '"^[f" forward-word' ]]; then
    bindkey '\ef' emacs-forward-word
  fi

  _oz_precmd
fi
:

# --- cli-ck add-on customizations ---

# 1. Oh My Zsh-like robbyrussell prompt
autoload -Uz vcs_info
precmd_vcs_info() { vcs_info }
precmd_functions+=(precmd_vcs_info)
setopt prompt_subst
zstyle ':vcs_info:git:*' formats '%F{240}(%F{red}%b%F{240})%f'
export PROMPT='%F{cyan}%c%f %F{green}➜%f '
export RPROMPT='${vcs_info_msg_0_}'

# 2. History configuration for autosuggestions
HISTFILE="$HOME/.zsh_history"
HISTSIZE=10000
SAVEHIST=10000
setopt appendhistory
setopt sharehistory

# 3. Load zsh-autosuggestions
AUTOSUGGEST_PATH="/opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh"
if [ ! -f "$AUTOSUGGEST_PATH" ]; then
    AUTOSUGGEST_PATH="/usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh"
fi
if [ ! -f "$AUTOSUGGEST_PATH" ]; then
    AUTOSUGGEST_PATH="$ZDOTDIR/zsh-autosuggestions/zsh-autosuggestions.zsh"
fi

if [ -f "$AUTOSUGGEST_PATH" ]; then
    source "$AUTOSUGGEST_PATH"
else
    # Automatically clone it in the background if git is available
    if [ ! -d "$ZDOTDIR/zsh-autosuggestions" ] && command -v git &>/dev/null; then
        (git clone --depth=1 https://github.com/zsh-users/zsh-autosuggestions "$ZDOTDIR/zsh-autosuggestions" &>/dev/null &)
    fi
fi

