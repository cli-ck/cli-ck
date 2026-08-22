# cli-ck-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _oz_user_zdotdir="${OZ_USER_ZDOTDIR:-$HOME}"
  [ -f "$_oz_user_zdotdir/.zprofile" ] && source "$_oz_user_zdotdir/.zprofile"
  unset _oz_user_zdotdir
}
:
